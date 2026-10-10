const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the real TypeScript modules with isolated database dependencies. These
// tests never connect to production or change orders/inventory.
function loadModule(file, mocks = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => name in mocks ? mocks[name] : require(name),
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    ...globals,
  }, { filename: file });
  return exports;
}

function queueHarness(refresh, onError) {
  const timers = new Map();
  let id = 0;
  const { createCoalescedRefresh } = loadModule('src/lib/utils/coalescedRefresh.ts', {}, {
    setTimeout: (callback) => { timers.set(++id, callback); return id; },
    clearTimeout: (timerId) => timers.delete(timerId),
  });
  return {
    queue: createCoalescedRefresh(refresh, 100, onError),
    timers,
    async tick() {
      const next = timers.entries().next().value;
      if (next) { timers.delete(next[0]); await next[1](); }
    },
  };
}

test('ten item events cause one refresh, without postponing the first timer', async () => {
  let calls = 0;
  const harness = queueHarness(async () => { calls++; });
  for (let i = 0; i < 10; i++) harness.queue.schedule();
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.keys()][0], 1);
  await harness.tick();
  assert.equal(calls, 1);
  assert.equal(harness.timers.size, 0);
});

test('events during a slow fetch cause one follow-up containing the final state', async () => {
  let databaseVersion = 1;
  let release;
  const observed = [];
  let running = 0;
  const harness = queueHarness(async () => {
    assert.equal(++running, 1, 'automatic refreshes must not overlap');
    const snapshot = databaseVersion;
    if (observed.length === 0) await new Promise(resolve => { release = resolve; });
    observed.push(snapshot);
    running--;
  });
  harness.queue.schedule();
  const first = harness.tick();
  for (let i = 2; i <= 10; i++) {
    databaseVersion = i;
    harness.queue.schedule();
  }
  assert.equal(harness.timers.size, 0);
  release();
  await first;
  assert.equal(harness.timers.size, 1);
  await harness.tick();
  assert.deepEqual(observed, [1, 10]);
});

test('unmount cancels pending requests and ignores future events', async () => {
  let calls = 0;
  const harness = queueHarness(async () => { calls++; });
  harness.queue.schedule();
  harness.queue.dispose();
  harness.queue.schedule();
  await harness.tick();
  assert.equal(calls, 0);
  assert.equal(harness.timers.size, 0);
});

test('unmount during a fetch prevents a queued follow-up', async () => {
  let release;
  let calls = 0;
  const harness = queueHarness(async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
  });
  harness.queue.schedule();
  const first = harness.tick();
  harness.queue.schedule();
  harness.queue.dispose();
  release();
  await first;
  await harness.tick();
  assert.equal(calls, 1);
  assert.equal(harness.timers.size, 0);
});

test('a failed request does not create an automatic retry loop', async () => {
  const errors = [];
  const harness = queueHarness(async () => { throw new Error('network failure'); }, error => errors.push(error));
  harness.queue.schedule();
  await harness.tick();
  assert.equal(errors.length, 1);
  assert.equal(harness.timers.size, 0);
  harness.queue.schedule();
  await harness.tick();
  assert.equal(errors.length, 2);
});

function summaryRepository(result) {
  const calls = [];
  const query = {
    select(fields) { calls.push(['select', fields]); return this; },
    in(field, ids) {
      calls.push(['in', field, Array.from(ids)]);
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  const { OrderSessionRepository } = loadModule('src/data/repositories/OrderSessionRepository.ts', {
    '../supabase/server-client': { supabaseAdmin: { from(table) { calls.push(['from', table]); return query; } } },
    '@/models/enums/SessionStatus': { SessionStatus: { OPEN: 'open' } },
  });
  return { OrderSessionRepository, calls };
}

test('board metadata uses one query, deduplicates IDs and excludes nested orders', async () => {
  const summary = { id: 'tab-a', session_number: 'TAB-1', status: 'open', opened_at: '2026-10-01' };
  const { OrderSessionRepository, calls } = summaryRepository({ data: [summary], error: null });
  const result = await OrderSessionRepository.getBoardSummaries(['tab-a', 'tab-a', 'tab-b']);
  assert.equal(result[0], summary);
  assert.deepEqual(calls, [
    ['from', 'order_sessions'],
    ['select', 'id, session_number, status, opened_at'],
    ['in', 'id', ['tab-a', 'tab-b']],
  ]);
});

test('a board without tabs makes no metadata query; query errors preserve fallback behavior', async () => {
  const { OrderSessionRepository, calls } = summaryRepository({ data: null, error: { message: 'unavailable' } });
  assert.equal((await OrderSessionRepository.getBoardSummaries([])).length, 0);
  assert.equal(calls.length, 0);
  assert.equal((await OrderSessionRepository.getBoardSummaries(['tab-a'])).length, 0);
  const rejected = summaryRepository(() => Promise.reject(new Error('network unavailable')));
  assert.equal((await rejected.OrderSessionRepository.getBoardSummaries(['tab-a'])).length, 0);
});

test('board response preserves grouping, totals, sorting and missing-session fallbacks', async () => {
  const requests = [];
  const orders = [
    { id: 'one', session_id: 'tab-a', total_amount: 10, created_at: '2026-10-01T10:00:00Z', customer: { full_name: 'Guest' }, table: { table_number: '1' } },
    { id: 'two', session_id: 'tab-a', total_amount: 20, created_at: '2026-10-01T09:00:00Z' },
    { id: 'three', session_id: 'missing', total_amount: 5, created_at: '2026-10-02T10:00:00Z' },
    { id: 'four', total_amount: 7, created_at: '2026-10-03T10:00:00Z' },
  ];
  const { GET } = loadModule('src/app/api/orders/board/route.ts', {
    'next/server': { NextResponse: { json: (body) => body } },
    '@/data/repositories/OrderRepository': { OrderRepository: {
      getAllWithDetails: async (options) => { requests.push(options); return orders; },
    } },
    '@/data/repositories/OrderSessionRepository': { OrderSessionRepository: {
      getBoardSummaries: async (ids) => {
        assert.deepEqual(Array.from(ids), ['tab-a', 'missing']);
        return [{ id: 'tab-a', session_number: 'TAB-1', status: 'open', opened_at: '2026-10-01T08:00:00Z' }];
      },
      getById: () => { throw new Error('sequential per-session lookup must not run'); },
    } },
  });
  const body = await GET({ nextUrl: new URL('https://example.test/api/orders/board?status=pending&limit=50') });
  assert.equal(body.success, true);
  assert.equal(requests[0].status, 'pending');
  assert.equal(requests[0].limit, 50);
  assert.equal(body.total_sessions, 2);
  assert.equal(body.total_standalone, 1);
  assert.equal(body.standalone_orders[0], orders[3]);
  assert.equal(body.sessions[0].session_id, 'missing');
  assert.equal(body.sessions[0].session_number, 'SESSION-missing');
  assert.equal(body.sessions[0].session_status, 'unknown');
  const tab = body.sessions[1];
  assert.equal(tab.total_amount, 30);
  assert.equal(tab.orders.length, 2);
  assert.equal(tab.customer, orders[0].customer);
  assert.equal(tab.table, orders[0].table);
  assert.equal(tab.earliest_created_at, orders[1].created_at);
  assert.equal(tab.session_number, 'TAB-1');
  assert.equal(tab.session_opened_at, '2026-10-01T08:00:00Z');
});

function stockService(result) {
  const queries = [];
  const { StockDeduction } = loadModule('src/core/services/inventory/StockDeduction.ts', {
    '@/data/repositories/InventoryRepository': { InventoryRepository: {} },
    '@/data/repositories/PackageRepository': { PackageRepository: {} },
    '@/lib/errors/AppError': { AppError: Error },
    '@/data/supabase/server-client': { supabaseAdmin: { from(table) {
      assert.equal(table, 'products');
      return { select(fields) {
        assert.equal(fields, 'id, name, current_stock');
        return { in(field, ids) {
          queries.push(Array.from(ids));
          assert.equal(field, 'id');
          return Promise.resolve(result);
        } };
      } };
    } } },
  });
  return { StockDeduction, queries };
}

test('confirmation reads fresh stock in one query and preserves per-item shortage results', async () => {
  const result = { data: [
    { id: 'beer', name: 'Beer', current_stock: 10 },
    { id: 'food', name: 'Food', current_stock: 1 },
    { id: 'empty', name: 'Empty', current_stock: null },
  ], error: null };
  const { StockDeduction, queries } = stockService(result);
  const items = [
    { product_id: 'beer', quantity: 2 },
    { product_id: 'beer', quantity: 3 },
    { product_id: 'food', quantity: 2 },
    { product_id: 'empty', quantity: 1 },
    { product_id: 'missing', quantity: 1 },
    { product_id: null, quantity: 2 },
  ];
  const checked = await StockDeduction.checkStockAvailability(items);
  assert.deepEqual(queries, [['beer', 'food', 'empty', 'missing']]);
  assert.equal(checked.available, false);
  assert.deepEqual(JSON.parse(JSON.stringify(checked.insufficientItems)), [
    { productId: 'food', requested: 2, available: 1 },
    { productId: 'empty', requested: 1, available: 0 },
    { productId: 'missing', requested: 1, available: 0 },
  ]);
  result.data[0].current_stock = 0;
  const next = await StockDeduction.checkStockAvailability([{ product_id: 'beer', quantity: 1 }]);
  assert.equal(queries.length, 2, 'stock must be queried again, never cached');
  assert.equal(next.available, false);
});

test('stock query failures still block confirmation; package-only orders skip the product query', async () => {
  const { StockDeduction, queries } = stockService({ data: null, error: { message: 'unavailable' } });
  const empty = await StockDeduction.checkStockAvailability([{ product_id: null, quantity: 1 }]);
  assert.equal(empty.available, true);
  assert.equal(queries.length, 0);
  const failed = await StockDeduction.checkStockAvailability([{ product_id: 'beer', quantity: 1 }]);
  assert.equal(failed.available, false);
  assert.equal(failed.insufficientItems[0].available, 0);
});

function routingService() {
  const lookups = [];
  const routed = [];
  const { KitchenRouting } = loadModule('src/core/services/kitchen/KitchenRouting.ts', {
    '@/data/repositories/KitchenOrderRepository': { KitchenOrderRepository: {
      createBatch: async (items) => { routed.push(...items); },
    } },
    '@/data/repositories/ProductRepository': { ProductRepository: {
      getById: async (id) => { lookups.push(id); return { id, name: 'Beer', category: { default_destination: 'bartender' } }; },
    } },
    '@/data/repositories/PackageRepository': { PackageRepository: {} },
    '@/lib/errors/AppError': { AppError: Error },
  });
  return { KitchenRouting, lookups, routed };
}

test('routing reuses joined metadata while preserving destinations, notes and package expansion', async () => {
  const { KitchenRouting, lookups, routed } = routingService();
  await KitchenRouting.routeOrder('order-1', [
    { id: 'item-1', product_id: 'beer', item_name: 'Beer', notes: 'Cold', product: { id: 'beer', name: 'Beer', category: { default_destination: 'bartender' } } },
    { id: 'item-2', product_id: 'food', item_name: 'Wings', product: { id: 'food', name: 'Wings', category: { default_destination: 'kitchen' } } },
    { id: 'item-3', product_id: 'both', item_name: 'Combo', product: { id: 'both', name: 'Combo', category: { default_destination: 'both' } } },
    { id: 'item-4', product_id: 'unknown', item_name: 'Beer', product: { id: 'unknown', name: 'Beer', category: null } },
    { id: 'item-5', package_id: 'pkg', item_name: 'Pack', package: { name: 'Pack', items: [
      { quantity: 2, product: { id: 'package-beer', name: 'Beer', category: { default_destination: 'bartender' } } },
    ] } },
  ]);
  assert.equal(lookups.length, 0);
  assert.deepEqual(routed.map(row => row.destination), ['bartender', 'kitchen', 'both', 'bartender', 'bartender']);
  assert.equal(routed[0].special_instructions, 'Cold');
  assert.equal(routed[4].order_item_id, 'item-5');
  assert.equal(routed[4].special_instructions, 'Package: Pack (x2)');
});

test('routing retains the database fallback for incomplete or mismatched joined products', async () => {
  const { KitchenRouting, lookups, routed } = routingService();
  await KitchenRouting.routeOrder('order-1', [
    { id: 'a', product_id: 'bare', item_name: 'Beer' },
    { id: 'b', product_id: 'incomplete', item_name: 'Beer', product: { id: 'incomplete', name: 'Beer' } },
    { id: 'c', product_id: 'mismatch', item_name: 'Beer', product: { id: 'other', name: 'Beer', category: null } },
  ]);
  assert.deepEqual(lookups, ['bare', 'incomplete', 'mismatch']);
  assert.equal(routed.length, 3);
  assert.ok(routed.every(row => row.destination === 'bartender'));
});
