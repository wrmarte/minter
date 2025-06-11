// utils/provider.js
const { ethers } = require('ethers');

// Locked to only BASE since v1 uses Base
const BASE_RPC = 'https://mainnet.base.org';

// ✅ Correct instantiation of JsonRpcProvider using Ethers v6
const provider = new ethers.JsonRpcProvider(BASE_RPC);

module.exports = provider;





















