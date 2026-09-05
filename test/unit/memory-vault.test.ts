import { vaultContract } from "./vault-contract.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
vaultContract("memory",()=>new MemoryVault());
