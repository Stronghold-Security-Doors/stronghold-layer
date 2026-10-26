// The monday adapter: the only file that talks to monday.com.
// Everything else asks for "the item", "set this column", "move to this group" and never sees GraphQL.
const API = process.env.MONDAY_API_URL || 'https://api.monday.com/v2';

async function gql(query, variables = {}) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN is not set in Render → Environment');
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' }, body: JSON.stringify({ query, variables }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors || data.error_message) throw new Error('monday: ' + (data.errors ? data.errors.map(e => e.message).join('; ') : data.error_message || res.status));
  return data.data;
}

export async function me() { const d = await gql('query { me { id name email } }'); return d.me; }

export async function boards() {
  const d = await gql('query { boards(limit: 100, order_by: used_at) { id name type columns { id title type } groups { id title } } }');
  return (d.boards || []).filter(b => b.type === 'board');
}
export async function board(id) {
  const d = await gql('query($ids:[ID!]) { boards(ids:$ids) { id name columns { id title type settings_str } groups { id title } } }', { ids: [String(id)] });
  return d.boards && d.boards[0];
}
export async function boardItems(id, limit = 50) {
  const d = await gql('query($ids:[ID!],$limit:Int) { boards(ids:$ids) { items_page(limit:$limit) { items { id name group { title } } } } }', { ids: [String(id)], limit });
  return ((d.boards && d.boards[0] && d.boards[0].items_page.items) || []);
}

// Reads one item and returns a plain object keyed by column TITLE, the way the canvas rules are written.
export async function readItem(itemId) {
  const d = await gql('query($ids:[ID!]) { items(ids:$ids) { id name board { id } group { id title } column_values { id text type value column { title } } } }', { ids: [String(itemId)] });
  const it = d.items && d.items[0];
  if (!it) return null;
  const item = { 'Item name': it.name, 'Project name': it.name, 'Group': it.group ? it.group.title : '', '__id': it.id, '__board': it.board.id, '__group': it.group ? it.group.id : '' };
  const ids = {};
  for (const cv of it.column_values) { const t = cv.column ? cv.column.title : cv.id; item[t] = cv.text || ''; ids[t] = { id: cv.id, type: cv.type }; }
  item.__columns = ids;
  return item;
}

export async function setColumn(boardId, itemId, columnId, value) {
  await gql('mutation($b:ID!,$i:ID!,$c:String!,$v:String!) { change_simple_column_value(board_id:$b, item_id:$i, column_id:$c, value:$v) { id } }', { b: String(boardId), i: String(itemId), c: columnId, v: String(value ?? '') });
}
export async function moveToGroup(itemId, groupId) {
  await gql('mutation($i:ID!,$g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }', { i: String(itemId), g: groupId });
}
export async function createItem(boardId, name, columnValues = {}) {
  const d = await gql('mutation($b:ID!,$n:String!,$cv:JSON) { create_item(board_id:$b, item_name:$n, column_values:$cv) { id } }', { b: String(boardId), n: name, cv: JSON.stringify(columnValues) });
  return d.create_item.id;
}
export async function postUpdate(itemId, body) {
  await gql('mutation($i:ID!,$body:String!) { create_update(item_id:$i, body:$body) { id } }', { i: String(itemId), body });
}
export async function webhooks(boardId) {
  const d = await gql('query($b:ID!) { webhooks(board_id:$b) { id event config } }', { b: String(boardId) });
  return d.webhooks || [];
}
export async function createWebhook(boardId, url, event) {
  const d = await gql('mutation($b:ID!,$u:String!,$e:WebhookEventType!) { create_webhook(board_id:$b, url:$u, event:$e) { id } }', { b: String(boardId), u: url, e: event });
  return d.create_webhook.id;
}
export async function deleteWebhook(id) { await gql('mutation($id:ID!) { delete_webhook(id:$id) { id } }', { id: String(id) }); }

// Paged read of a whole board (used by the mirror). cursor=null for the first page.
const ITEM_FIELDS = 'id name created_at updated_at group { id title } column_values { id text type value column { title } }';
export async function itemsPage(boardId, cursor, limit = 100) {
  if (!cursor) { const d = await gql(`query($ids:[ID!],$limit:Int) { boards(ids:$ids) { items_page(limit:$limit) { cursor items { ${ITEM_FIELDS} } } } }`, { ids: [String(boardId)], limit }); return d.boards && d.boards[0] ? d.boards[0].items_page : { items: [], cursor: null }; }
  const d = await gql(`query($cursor:String!,$limit:Int) { next_items_page(cursor:$cursor, limit:$limit) { cursor items { ${ITEM_FIELDS} } } }`, { cursor, limit }); return d.next_items_page;
}
export async function itemFull(itemId) { const d = await gql(`query($ids:[ID!]) { items(ids:$ids) { ${ITEM_FIELDS} board { id } } }`, { ids: [String(itemId)] }); return d.items && d.items[0]; }
export async function updatesFor(itemId) { const d = await gql('query($ids:[ID!]) { items(ids:$ids) { updates(limit:50) { id text_body created_at creator { name } } } }', { ids: [String(itemId)] }); return (d.items && d.items[0] && d.items[0].updates) || []; }
