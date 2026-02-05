// commands/trackmintplus.js  (OK to paste into commands/trackmint.js if that's what runs)
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { ethers } = require('ethers');

let TOKEN_NAME_TO_ADDRESS = {};
try {
  ({ TOKEN_NAME_TO_ADDRESS } = require('../constants'));
} catch {
  TOKEN_NAME_TO_ADDRESS = {};
}

const { trackAllContracts } = require('../services/mintRouter');

// Discord "ephemeral" deprecation: use flags where possible
const EPHEMERAL_FLAG = 1 << 6; // 64

function safeLower(s) {
  return String(s || '').trim().toLowerCase();
}
function safeTrim(s) {
  return String(s || '').trim();
}
function normalizeChain(chain) {
  const c = safeLower(chain);
  if (c === 'base' || c === 'eth' || c === 'ape') return c;
  return 'base';
}
function normalizeToken(tokenSymbolOrAddress) {
  const raw = safeTrim(tokenSymbolOrAddress || '');
  if (!raw) return { resolvedSymbol: 'ETH', tokenAddrOrInput: 'ETH' };

  if (raw.startsWith('0x') && raw.length === 42) {
    return { resolvedSymbol: 'TOKEN', tokenAddrOrInput: raw };
  }

  const sym = raw.toUpperCase();
  const mapped = TOKEN_NAME_TO_ADDRESS?.[sym];
  if (mapped && String(mapped).startsWith('0x') && String(mapped).length === 42) {
    return { resolvedSymbol: sym, tokenAddrOrInput: mapped };
  }

  return { resolvedSymbol: sym, tokenAddrOrInput: raw };
}

async function ensureWatchlistSchema(pg) {
  // Create minimal table if missing (legacy-safe: no id required)
  await pg.query(`
    CREATE TABLE IF NOT EXISTS contract_watchlist (
      name TEXT,
      address TEXT
    );
  `);

  // Add missing columns if needed (legacy-safe)
  await pg.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='chain'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN chain TEXT NOT NULL DEFAULT 'base';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='mint_price'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_price NUMERIC NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='mint_token'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_token TEXT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='mint_token_symbol'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_token_symbol TEXT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='channel_ids'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN channel_ids TEXT[] NULL DEFAULT '{}'::text[];
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='created_at'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='contract_watchlist' AND column_name='updated_at'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;

      BEGIN
        ALTER TABLE contract_watchlist ALTER COLUMN mint_price DROP NOT NULL;
      EXCEPTION WHEN others THEN END;

      BEGIN
        ALTER TABLE contract_watchlist ALTER COLUMN mint_token DROP NOT NULL;
      EXCEPTION WHEN others THEN END;

      BEGIN
        ALTER TABLE contract_watchlist ALTER COLUMN mint_token_symbol DROP NOT NULL;
      EXCEPTION WHEN others THEN END;
    END$$;
  `);
}

async function normalizeWatchlist(pg) {
  // Normalize address + chain, ensure timestamps exist
  try {
    await pg.query(`
      UPDATE contract_watchlist
      SET
        address = LOWER(TRIM(address)),
        chain = LOWER(TRIM(COALESCE(chain, 'base'))),
        created_at = COALESCE(created_at, NOW()),
        updated_at = COALESCE(updated_at, NOW())
      WHERE address IS NOT NULL;
    `);
  } catch (e) {
    console.warn('⚠️ [trackmintplus] normalize failed:', e?.message || e);
  }
}

async function dedupeWatchlistByCtid(pg) {
  // Remove duplicates for (chain,address) using ctid (works without id)
  try {
    await pg.query(`
      WITH ranked AS (
        SELECT
          ctid,
          chain,
          address,
          ROW_NUMBER() OVER (
            PARTITION BY chain, address
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          ) AS rn
        FROM contract_watchlist
        WHERE chain IS NOT NULL AND address IS NOT NULL
      )
      DELETE FROM contract_watchlist w
      USING ranked r
      WHERE w.ctid = r.ctid AND r.rn > 1;
    `);
  } catch (e) {
    console.warn('⚠️ [trackmintplus] dedupe delete failed:', e?.message || e);
  }
}

async function tryCreateUniqueIndex(pg) {
  try {
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname='public' AND indexname='contract_watchlist_chain_address_uq'
        ) THEN
          CREATE UNIQUE INDEX contract_watchlist_chain_address_uq
            ON contract_watchlist (chain, address);
        END IF;
      END$$;
    `);
    return true;
  } catch (e) {
    console.warn('⚠️ [trackmintplus] Could not create unique index (chain,address):', e?.message || e);
    return false;
  }
}

async function hasUniqueIndex(pg) {
  try {
    const r = await pg.query(`
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND indexname='contract_watchlist_chain_address_uq'
      LIMIT 1;
    `);
    return (r?.rows?.length || 0) > 0;
  } catch {
    return false;
  }
}

async function manualUpsertNoId(pg, payload) {
  const {
    name,
    addressLower,
    chain,
    mint_price,
    mint_token,
    mint_token_symbol,
    channelId,
  } = payload;

  // Find the row to update using ctid (stable for the duration of a statement)
  const existing = await pg.query(
    `
    SELECT ctid, name, address, chain, mint_price, mint_token, mint_token_symbol, channel_ids
    FROM contract_watchlist
    WHERE chain = $1 AND address = $2
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
    `,
    [chain, addressLower]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    const merged = Array.from(new Set([...(row.channel_ids || []), channelId].filter(Boolean).map(String)));

    const upd = await pg.query(
      `
      UPDATE contract_watchlist
      SET
        name = $1,
        mint_price = COALESCE($2, mint_price),
        mint_token = COALESCE(NULLIF($3,''), mint_token),
        mint_token_symbol = COALESCE(NULLIF($4,''), mint_token_symbol),
        channel_ids = $5::text[],
        updated_at = NOW()
      WHERE ctid = $6
      RETURNING *;
      `,
      [name, mint_price, mint_token || '', mint_token_symbol || '', merged, row.ctid]
    );

    return upd.rows[0];
  }

  const ins = await pg.query(
    `
    INSERT INTO contract_watchlist
      (name, address, chain, mint_price, mint_token, mint_token_symbol, channel_ids, created_at, updated_at)
    VALUES
      ($1,   $2,     $3,    $4,         $5,        $6,              $7::text[], NOW(), NOW())
    RETURNING *;
    `,
    [name, addressLower, chain, mint_price, mint_token || null, mint_token_symbol || null, [channelId]]
  );

  return ins.rows[0];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trackmintplus')
    .setDescription('Track a contract for minting and/or sales on any supported chain')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Contract name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true))
    .addStringOption(opt =>
      opt.setName('chain')
        .setDescription('Which chain? base, eth, ape')
        .setRequired(true)
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        ))
    .addNumberOption(opt =>
      opt.setName('price').setDescription('Mint price (optional)').setRequired(false))
    .addStringOption(opt =>
      opt.setName('token').setDescription('Mint token (symbol or address)').setRequired(false)),

  async execute(interaction) {
    const pg = interaction?.client?.pg;
    const { options, channel, member } = interaction;

    if (!pg || typeof pg.query !== 'function') {
      return interaction.reply({
        content: '❌ DB not attached to client (`interaction.client.pg` missing). Check your index.js wiring.',
        flags: EPHEMERAL_FLAG,
      });
    }

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '❌ Admin only.', flags: EPHEMERAL_FLAG });
    }

    const nameRaw = options.getString('name');
    const addrRaw = options.getString('address');
    const chain = normalizeChain(options.getString('chain') || 'base');
    const mint_price = options.getNumber('price') ?? null;
    const tokenInput = options.getString('token') || 'ETH';

    let address;
    try {
      address = ethers.getAddress(safeTrim(addrRaw));
    } catch {
      return interaction.reply({ content: '❌ Invalid contract address.', flags: EPHEMERAL_FLAG });
    }

    const name = safeTrim(nameRaw);
    const currentChannel = String(channel.id);
    const { resolvedSymbol, tokenAddrOrInput } = normalizeToken(tokenInput);

    await interaction.deferReply({ flags: EPHEMERAL_FLAG }).catch(() => null);

    // 1) schema
    try {
      await ensureWatchlistSchema(pg);
      await normalizeWatchlist(pg);
      await dedupeWatchlistByCtid(pg);
      await tryCreateUniqueIndex(pg); // may fail if duplicates still exist elsewhere; manual fallback handles it
    } catch (e) {
      console.error('❌ [trackmintplus] schema/cleanup failed:', e);
      return interaction.editReply('⚠️ DB schema/cleanup failed. Check logs.').catch(() => null);
    }

    const addressLower = address.toLowerCase();

    // 2) write
    try {
      const indexOk = await hasUniqueIndex(pg);
      let row = null;

      if (indexOk) {
        const insertRes = await pg.query(
          `
          INSERT INTO contract_watchlist
            (name, address, chain, mint_price, mint_token, mint_token_symbol, channel_ids, created_at, updated_at)
          VALUES
            ($1,   $2,     $3,    $4,         $5,        $6,              $7::text[], NOW(), NOW())
          ON CONFLICT (chain, address) DO UPDATE
          SET
            name = EXCLUDED.name,
            mint_price = COALESCE(EXCLUDED.mint_price, contract_watchlist.mint_price),
            mint_token = COALESCE(NULLIF(EXCLUDED.mint_token,''), contract_watchlist.mint_token),
            mint_token_symbol = COALESCE(NULLIF(EXCLUDED.mint_token_symbol,''), contract_watchlist.mint_token_symbol),
            channel_ids = (
              SELECT ARRAY(
                SELECT DISTINCT x
                FROM unnest(
                  COALESCE(contract_watchlist.channel_ids, '{}'::text[]) ||
                  COALESCE(EXCLUDED.channel_ids, '{}'::text[])
                ) AS x
                WHERE x IS NOT NULL AND x <> ''
              )
            ),
            updated_at = NOW()
          RETURNING *;
          `,
          [
            name,
            addressLower,
            chain,
            mint_price,
            tokenAddrOrInput || null,
            resolvedSymbol || null,
            [currentChannel]
          ]
        );
        row = insertRes?.rows?.[0] || null;
      } else {
        row = await manualUpsertNoId(pg, {
          name,
          addressLower,
          chain,
          mint_price,
          mint_token: tokenAddrOrInput || null,
          mint_token_symbol: resolvedSymbol || null,
          channelId: currentChannel
        });
      }

      if (!row) {
        console.warn('⚠️ [trackmintplus] write returned no row');
        return interaction.editReply('⚠️ DB write returned no row. Check logs.').catch(() => null);
      }

      // 3) router kick
      try {
        await trackAllContracts(interaction.client, row);
      } catch (e) {
        console.warn('⚠️ [trackmintplus] trackAllContracts failed:', e?.message || e);
      }

      const mode = mint_price != null ? 'minting and sales' : 'sales only';

      return interaction.editReply(
        `✅ Tracking saved in DB.\n` +
        `• **${row.name || name}**\n` +
        `• chain: \`${row.chain || chain}\`\n` +
        `• address: \`${row.address || addressLower}\`\n` +
        `• mode: **${mode}**\n` +
        `• token: \`${row.mint_token_symbol || resolvedSymbol || 'ETH'}\`\n` +
        `• channels: ${(row.channel_ids || []).length}`
      ).catch(() => null);

    } catch (err) {
      console.error('❌ [trackmintplus] DB write failed message:', err?.message);
      console.error('❌ [trackmintplus] DB write failed full:', err);
      return interaction.editReply(
        `⚠️ DB write failed.\n**Error:** ${String(err?.message || err)}`
      ).catch(() => null);
    }
  }
};

