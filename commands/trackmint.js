// commands/trackmintplus.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { ethers } = require('ethers');

let TOKEN_NAME_TO_ADDRESS = {};
try {
  ({ TOKEN_NAME_TO_ADDRESS } = require('../constants'));
} catch {
  TOKEN_NAME_TO_ADDRESS = {};
}

const { trackAllContracts } = require('../services/mintRouter');

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

  // If it looks like an address, return as-is
  if (raw.startsWith('0x') && raw.length === 42) {
    return { resolvedSymbol: 'TOKEN', tokenAddrOrInput: raw };
  }

  const sym = raw.toUpperCase();
  const mapped = TOKEN_NAME_TO_ADDRESS?.[sym];
  if (mapped && String(mapped).startsWith('0x') && String(mapped).length === 42) {
    return { resolvedSymbol: sym, tokenAddrOrInput: mapped };
  }

  // Keep the symbol (maybe processor resolves it later)
  return { resolvedSymbol: sym, tokenAddrOrInput: raw };
}

async function ensureWatchlistSchema(pg) {
  // 1) Create table if missing
  await pg.query(`
    CREATE TABLE IF NOT EXISTS contract_watchlist (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      chain TEXT NOT NULL DEFAULT 'base',
      mint_price NUMERIC NULL,
      mint_token TEXT NULL,
      mint_token_symbol TEXT NULL,
      channel_ids TEXT[] NULL DEFAULT '{}'::text[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2) Ensure columns exist (safe idempotent adds)
  await pg.query(`
    DO $$
    BEGIN
      -- Core columns (in case legacy table was created earlier)
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'name'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN name TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'address'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN address TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'chain'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN chain TEXT NOT NULL DEFAULT 'base';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'mint_price'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_price NUMERIC NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'mint_token'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_token TEXT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'mint_token_symbol'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN mint_token_symbol TEXT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'channel_ids'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN channel_ids TEXT[] NULL DEFAULT '{}'::text[];
      END IF;

      -- ✅ IMPORTANT: legacy tables often missing these
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'created_at'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contract_watchlist' AND column_name = 'updated_at'
      ) THEN
        ALTER TABLE contract_watchlist ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;

      -- Try to drop NOT NULL constraints if they exist (don’t crash)
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

  // 3) Add UNIQUE (chain,address) if possible (safe)
  try {
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'contract_watchlist_chain_address_uq'
        ) THEN
          CREATE UNIQUE INDEX contract_watchlist_chain_address_uq
            ON contract_watchlist (chain, address);
        END IF;
      END$$;
    `);
  } catch (e) {
    // If they already have a conflicting index/constraint, don’t crash.
    console.warn('⚠️ [trackmintplus] Could not create unique index (chain,address):', e?.message || e);
  }
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
        ephemeral: true
      });
    }

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
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
      return interaction.reply({ content: '❌ Invalid contract address.', ephemeral: true });
    }

    const name = safeTrim(nameRaw);
    const currentChannel = String(channel.id);

    const { resolvedSymbol, tokenAddrOrInput } = normalizeToken(tokenInput);

    await interaction.deferReply({ ephemeral: true });

    // ✅ Ensure schema exists (including CREATE TABLE)
    try {
      await ensureWatchlistSchema(pg);
    } catch (e) {
      console.error('❌ [trackmintplus] schema ensure failed:', e);
      return interaction.editReply('⚠️ DB schema migration failed. Check Railway logs for details.');
    }

    // ✅ UPSERT by (chain,address) + merge channel_ids
    try {
      const insertRes = await pg.query(
        `
        INSERT INTO contract_watchlist
          (name, address, chain, mint_price, mint_token, mint_token_symbol, channel_ids)
        VALUES
          ($1,   $2,     $3,    $4,         $5,        $6,              $7::text[])
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
          address.toLowerCase(),     // store normalized
          chain,
          mint_price,
          tokenAddrOrInput || null,
          resolvedSymbol || null,
          [currentChannel]
        ]
      );

      const row = insertRes?.rows?.[0];
      if (!row) {
        console.warn('⚠️ [trackmintplus] upsert returned no row');
        return interaction.editReply('⚠️ DB write happened but returned no row. Check logs.');
      }

      // Kick router to track this contract immediately
      try {
        await trackAllContracts(interaction.client, row);
      } catch (e) {
        console.warn('⚠️ [trackmintplus] trackAllContracts failed:', e?.message || e);
        // Not fatal; DB is written.
      }

      const mode = mint_price != null ? 'minting and sales' : 'sales only';

      return interaction.editReply(
        `✅ Tracking saved in DB.\n` +
        `• **${row.name}**\n` +
        `• chain: \`${row.chain}\`\n` +
        `• address: \`${row.address}\`\n` +
        `• mode: **${mode}**\n` +
        `• token: \`${row.mint_token_symbol || resolvedSymbol || 'ETH'}\`\n` +
        `• channels: ${(row.channel_ids || []).length}`
      );
    } catch (err) {
      // ✅ Print message clearly so you see the missing column if anything else is off
      console.error('❌ [trackmintplus] DB upsert failed message:', err?.message);
      console.error('❌ [trackmintplus] DB upsert failed full:', err);

      return interaction.editReply(
        `⚠️ DB write failed.\n` +
        `**Error:** ${String(err?.message || err)}`
      );
    }
  }
};
