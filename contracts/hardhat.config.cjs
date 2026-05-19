require('dotenv/config');
require('@nomicfoundation/hardhat-toolbox');

const PRIVATE_KEY = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      // Increase block gas limit so initial Poseidon deployment fits.
      blockGasLimit: 30_000_000,
      allowUnlimitedContractSize: true,
    },
    paseoTestnet: {
      url: process.env.PASEO_RPC_URL || 'https://eth-rpc-testnet.polkadot.io/',
      chainId: 420420417,
      accounts: PRIVATE_KEY,
    },
    chopsticks: {
      url: process.env.CHOPSTICKS_RPC_URL || 'http://127.0.0.1:8545',
      // The eth-rpc bridge in front of chopsticks uses the same Paseo Asset Hub chainId.
      chainId: 420420417,
      accounts: PRIVATE_KEY,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: { timeout: 180_000 },
};
