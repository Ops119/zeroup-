const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.24";

// Use the solc-js build shipped in node_modules instead of downloading one, so
// compilation works offline and behind proxies.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== SOLC_VERSION) return runSuper();
  const solcPkg = require("solc/package.json");
  return {
    compilerPath: path.join(path.dirname(require.resolve("solc/package.json")), "soljson.js"),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: solcPkg.version,
  };
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./contracts", artifacts: "./artifacts", cache: "./cache" },
  networks: {
    hardhat: { chainId: 31337 },
  },
};
