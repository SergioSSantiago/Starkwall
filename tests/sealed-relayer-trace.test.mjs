import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SEALED_RELAY_DISABLE_AUTOSTART = '1';

const relayer = await import('../sealed-relayer-server.js');
const t = relayer.__test__;

test('trace fallback exposes reverify metadata without secrets', () => {
  t.jobs.length = 0;
  t.tracesByKey.clear();

  t.upsertTraceFromJobLike({
    id: 'trace_job_1',
    slotPostId: 123,
    groupId: 77,
    bidder: '0xabc',
    bidAmount: 10,
    salt: '0xdeadbeef',
    proofCalldata: ['1', '2', '3'],
    zkTrace: { proofCalldataHash: '0xhash', proofFelts: 3 },
    updatedAt: Date.now(),
  });

  const rows = t.collectPublicJobsWithTraceFallback();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slotPostId, 123);
  assert.equal(rows[0].hasProofCalldata, true);
  assert.equal('salt' in rows[0], false);
  assert.equal('proofCalldata' in rows[0], false);
});

test('live jobs take priority over trace fallback for same slot+bidder', () => {
  t.jobs.length = 0;
  t.tracesByKey.clear();

  t.upsertTraceFromJobLike({
    id: 'trace_job_2',
    slotPostId: 555,
    bidder: '0xbbb',
    bidAmount: 9,
    proofCalldata: ['10'],
    updatedAt: Date.now(),
  });

  t.jobs.push({
    id: 'live_job_2',
    slotPostId: 555,
    bidder: '0xbbb',
    bidAmount: 9,
    status: 'submitted',
    proofCalldata: ['10'],
    updatedAt: Date.now(),
  });

  const rows = t.collectPublicJobsWithTraceFallback();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'live_job_2');
  assert.equal(rows[0].hasProofCalldata, true);
});

test('decodes reveal payload from account multicall calldata', async () => {
  const { hash } = await import('starknet');
  const actions = '0x9b693df0de1b9217493ea72b159beaea15c4299130a1a31279fd7a64adcb8d';
  const selector = BigInt(hash.getSelectorFromName('reveal_bid')).toString(10);
  const slot = '340';
  const bidder = '0x06721100000000000000000000000000000000000000000000000000000e250e';
  const bid = '12';
  const salt = '0x1234';
  const proof = ['11', '22', '33'];
  const data = [
    slot,
    BigInt(bidder).toString(10),
    bid,
    BigInt(salt).toString(10),
    String(proof.length),
    ...proof,
  ];
  const calldata = [
    '1', // calls_len
    BigInt(actions).toString(10), // to
    selector, // selector reveal_bid
    '0', // data_offset
    String(data.length), // data_len
    String(data.length), // calldata_len
    ...data,
  ];
  const parsed = t.extractRevealPayloadFromAccountCalldata(calldata, actions);
  assert.ok(parsed);
  assert.equal(parsed.slotPostId, 340);
  assert.equal(parsed.bidder, '0x6721100000000000000000000000000000000000000000000000000000e250e');
  assert.equal(parsed.bidAmount, 12);
  assert.equal(parsed.salt, '0x1234');
  assert.deepEqual(parsed.proofCalldata, proof);
});
