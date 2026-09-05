import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId } from "../../src/domain/ids.js";
import { DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
describe("domain identifier parsing",()=>{
  it("accepts canonical identifiers",()=>{assert.equal(parseCustomerId("customer_01JTEST0000000000000000000"),"customer_01JTEST0000000000000000000");assert.equal(parseCaseId("case_01JTEST0000000000000000000"),"case_01JTEST0000000000000000000");assert.equal(parseGrantId("grant_01JTEST0000000000000000000"),"grant_01JTEST0000000000000000000");assert.equal(parseDumpId("dump_01JTEST0000000000000000000"),"dump_01JTEST0000000000000000000");});
  it("rejects paths and wrong kinds",()=>{assert.throws(()=>parseDumpId("../../customer-data.dmp"),/invalid dump identifier/i);assert.throws(()=>parseDumpId("case_01JTEST0000000000000000000"),/invalid dump identifier/i);});
  it("keeps deterministic IDs Crockford-valid beyond forty IDs",()=>{const ids=new DeterministicIds();for(let i=0;i<128;i+=1)assert.doesNotThrow(()=>parseDumpId(ids.next("dump")));});
});
