// Explicitly opt-in: modifies only the supplied disposable project.
// OL_TEST_COOKIE_CONFIG is an olcli credential file; never printed or committed.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveStored } from '../../dist/auth/cookieStore.js';

const project = process.argv[2];
if (!project || !process.env.OL_BASE_URL || !process.env.OL_TEST_COOKIE_CONFIG || !process.env.XDG_CONFIG_HOME) {
  throw new Error('Supply disposable project ID, OL_BASE_URL, OL_TEST_COOKIE_CONFIG and isolated XDG_CONFIG_HOME.');
}
const auth = JSON.parse(await readFile(process.env.OL_TEST_COOKIE_CONFIG, 'utf8'));
assert.equal(auth.baseUrl, process.env.OL_BASE_URL, 'Credential origin mismatch');
await saveStored(auth.baseUrl, `${auth.sessionCookieName}=${auth.sessionCookie}`);
const dir = await mkdtemp(resolve(process.env.XDG_CONFIG_HOME, 'artifacts-'));
const client = new Client({ name: 'extensions-test', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: process.env });
const suffix = Date.now();
const note = `notes-test-${suffix}.tex`;
async function call(name, args = {}, error = false) {
  if (args.path === 'notes-test.tex') args.path = note;
  const r = await client.callTool({ name, arguments: args });
  console.log(name, JSON.stringify(r));
  assert.equal(!!r.isError, error, `${name} unexpected status`);
  if (r.structuredContent) return r.structuredContent;
  try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
}
try {
  await client.connect(transport);
  console.log('tools', (await client.listTools()).tools.length);
  await call('open_project', { project_id: project });
  await call('create_folder', { path: 'assets-test' });
  await call('create_file', { path: 'notes-test.tex' });
  await call('read_file', { path: 'notes-test.tex' });
  await call('edit_file', { path: 'notes-test.tex', new_content: 'Unique anchor text.\n', track: 'on', strict_version: true });
  const doc = await call('read_file', { path: 'notes-test.tex' });
  assert.ok(doc.tracked_change_count > 0);
  await call('add_comment', { path: 'notes-test.tex', selected_text: 'Unique anchor', content: 'MCP integration anchor test', expected_version: doc.version });
  await call('add_comment', { path: 'notes-test.tex', selected_text: 'Unique anchor', content: 'Must reject stale version', expected_version: doc.version }, true);
  await call('download_file', { path: 'notes-test.tex', output_path: `${dir}/notes.tex` });
  assert.equal(await readFile(`${dir}/notes.tex`, 'utf8'), doc.text);
  await call('download_file', { path: 'notes-test.tex', output_path: `${dir}/notes.tex` }, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(`${dir}/pixel.png`, png);
  await call('upload_file', { path: 'assets-test/pixel.png', local_path: `${dir}/pixel.png` });
  await call('upload_file', { path: 'assets-test/pixel.png', local_path: `${dir}/pixel.png` }, true);
  await call('download_file', { path: 'assets-test/pixel.png', output_path: `${dir}/roundtrip.png` });
  assert.deepEqual(await readFile(`${dir}/roundtrip.png`), png);
  await call('rename_entity', { path: 'assets-test/pixel.png', new_name: 'renamed.png' });
  await call('delete_entity', { path: 'assets-test', confirm: true }, true);
  await call('delete_entity', { path: 'assets-test/renamed.png', confirm: false }, true);
  await call('delete_entity', { path: 'assets-test/renamed.png', confirm: true });
  await call('delete_entity', { path: 'assets-test', confirm: true });
  const other = new Client({ name: 'concurrent-writer-test', version: '1' });
  try {
    await other.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: process.env }));
    assert.ok(!(await other.callTool({ name: 'open_project', arguments: { project_id: project } })).isError);
    const baseline = await call('read_file', { path: note });
    assert.ok(!(await other.callTool({ name: 'read_file', arguments: { path: note } })).isError);
    await call('edit_file', { path: note, new_content: baseline.text + 'Writer A\n', track: 'on' });
    // B has not refreshed: let the server transform its original baseline against A.
    const merged = await other.callTool({ name: 'edit_file', arguments: { path: note, new_content: 'Writer B\n' + baseline.text, track: 'on', strict_version: false } });
    assert.ok(!merged.isError, JSON.stringify(merged));
    const final = await call('read_file', { path: note });
    assert.equal(final.text, 'Writer B\n' + baseline.text + 'Writer A\n');
    assert.ok(!(await other.callTool({ name: 'read_file', arguments: { path: note } })).isError);
    await call('edit_file', { path: note, new_content: final.text + 'Writer A second\n', track: 'on' });
    const stale = await other.callTool({ name: 'edit_file', arguments: { path: note, new_content: 'Writer B second\n' + final.text, track: 'on', strict_version: true } });
    assert.equal(stale.isError, true, 'strict stale write must fail');
    // Strict rejection refreshes the upstream cache. Never retry old new_content
    // against that new baseline; the agent must read and recompute its edit.
    const afterRejection = await call('read_file', { path: note });
    assert.equal(afterRejection.text, final.text + 'Writer A second\n');
    console.log('PASS concurrent OT merge and strict stale rejection');
  } finally { await other.close(); }
  await call('compile');
  await call('download_output', { output_path: `${dir}/output.pdf` });
  assert.equal((await readFile(`${dir}/output.pdf`)).subarray(0, 5).toString(), '%PDF-');
  await call('download_output', { output_path: `${dir}/output.log`, artifact: 'output.log' });
  await call('download_project', { output_path: `${dir}/project.zip` });
  assert.equal((await readFile(`${dir}/project.zip`)).subarray(0, 2).toString(), 'PK');
  console.log('PASS', dir);
} finally { await client.close(); }
