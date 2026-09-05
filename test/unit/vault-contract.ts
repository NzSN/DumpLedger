import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { parseDumpId } from "../../src/domain/ids.js";
import type { Vault } from "../../src/vault/vault.js";
export function vaultContract(name:string,makeVault:()=>Vault):void{describe(`${name} vault contract`,()=>{
  it("stages, seals, promotes, reads, and removes immutable bytes",()=>{const vault=makeVault(),id=parseDumpId("dump_01JTEST0000000000000000001");vault.createStaging(id);assert.throws(()=>vault.createStaging(id));vault.append(id,Uint8Array.from([77,68]));vault.append(id,Uint8Array.from([77,80]));vault.syncAndClose(id);assert.deepEqual(vault.inspectPresence(id),{staging:true,vault:false});vault.promote(id);vault.promote(id);const reader=vault.openImmutable(id);try{assert.equal(reader.size,4n);assert.deepEqual(reader.read(0n,4),Uint8Array.from([77,68,77,80]));}finally{reader.close();}vault.remove(id);vault.remove(id);assert.deepEqual(vault.inspectPresence(id),{staging:false,vault:false});});
  it("does not append after sealing",()=>{const vault=makeVault(),id=parseDumpId("dump_01JTEST0000000000000000002");vault.createStaging(id);vault.syncAndClose(id);assert.throws(()=>vault.append(id,Uint8Array.of(1)));});
});}
