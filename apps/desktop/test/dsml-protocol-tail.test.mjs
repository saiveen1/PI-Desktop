import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { splitDsmlProtocolTail: split } = await import('../src/lib/dsml-protocol-tail.ts');
const param = '<｜DSML｜ parameter name="timeout" string="false">120</｜DSML｜ parameter>';
const invoke = '</｜DSML｜ invoke>';
const calls = '</｜DSML｜ calls>';
const prose = '第一步完成。\r\n\r\n';

test('short and long orphan tails retain exact source bytes', () => {
  for (const tail of [param + calls, `${param} ${calls}`, `${param}\r\n${invoke}\r\n${calls}  \r\n`, `</｜DSML｜ parameter>\n${param}\n${invoke}\n${calls}`, `${invoke}\n${calls}`]) {
    for (const prefix of ['', prose, 'The provisional answer.\n']) {
      assert.deepEqual(split(prefix + tail), { prose: prefix, tail });
    }
  }
});

test('only complete, high-confidence plain-prose suffixes fold', () => {
  const tail = `${param}\n${invoke}\n${calls}`;
  for (const source of [
    calls, param, tail.slice(0, -1), `${tail}\nStill explaining.`, `Here is a tag: ${tail}`,
    `\`\`\`xml\n${tail}`, `~~~xml\n${tail}\n~~~`, tail.split('\n').map(s => `> ${s}`).join('\n'),
    tail.split('\n').map(s => `    ${s}`).join('\n'), `<!--\n${tail}`,
    `<｜DSML｜ calls>\n<｜DSML｜ invoke name="Bash">\n${tail}`,
    `These tags are literals: \`${param}${calls}\``, `> quoted example\n${tail}`,
    `- Example:\n  \`\`\`xml\n  ${param}\n  ${calls}`,
  ]) assert.equal(split(source), undefined, source);
  const prefix = `\`\`\`\n${tail}\n\`\`\`\n\nReal reply.\n`;
  assert.deepEqual(split(prefix + tail), { prose: prefix, tail });
});
