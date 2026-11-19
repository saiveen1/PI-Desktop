import { describe, expect, it } from "vitest";
import { textToolCallDiagnostic } from "./text-tool-call.js";

const tools = new Map([["TodoWrite", {}]]);
const xml = '<tool_call>\n<function=TodoWrite>\n<parameter=todos>\n[]\n</parameter>\n</function>\n</tool_call>';

describe("text tool-call diagnostics", () => {
  it.each([xml, `Workspace checked.\n${xml}`, xml.replaceAll("\n", "")])("recognizes a complete call outside code", (text) => {
    expect(textToolCallDiagnostic(text, tools)?.code).toBe("TOOL_CALL_NOT_EXECUTED");
  });
  it.each([
    `\`\`\`xml\n${xml}\n\`\`\``,
    `~~~xml\n${xml}\n~~~`,
    `\`\`\`\`xml\n\`\`\`\n${xml}\n\`\`\`\``,
    `\`${xml.replaceAll("\n", "")}\``,
    xml.split("\n").map((line) => `> ${line}`).join("\n"),
    xml.split("\n").map((line) => `    ${line}`).join("\n"),
    xml.replace("</tool_call>", ""),
    xml.replace("</function>", ""),
    xml.replace("TodoWrite", "UnknownTool"),
    "The task is complete.",
  ])("leaves examples, incomplete calls and unknown names alone", (text) => {
    expect(textToolCallDiagnostic(text, tools)).toBeUndefined();
  });
  it("still checks prose following a fenced example", () => {
    expect(textToolCallDiagnostic(`~~~xml\n${xml}\n~~~\n${xml}`, tools)?.code).toBe("TOOL_CALL_NOT_EXECUTED");
  });
});

const dsml = [
  '</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>',
  '</｜DSML｜ invoke>',
  '</｜DSML｜ calls>',
].join("\n");

const compactDsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">printf checked</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';

describe("DSML tool-call leakage diagnostics", () => {
  it.each([
    dsml,
    compactDsml,
    `I will run the remaining check.\n\n${dsml}`,
    `<｜DSML｜ calls>\n<｜DSML｜ invoke name="Bash">\n${dsml}`,
  ])("recognizes a complete envelope or orphaned protocol tail", (text) => {
    expect(textToolCallDiagnostic(text, tools)).toMatchObject({ code: "TOOL_CALL_NOT_EXECUTED", retriable: true });
  });

  it.each([
    `\`\`\`xml\n${dsml}\n\`\`\``,
    `~~~xml\n${dsml}\n~~~`,
    `\`\`\`\`xml\n\`\`\`\n${dsml}\n\`\`\`\``,
    dsml.split("\n").map((line) => `> ${line}`).join("\n"),
    dsml.split("\n").map((line) => `    ${line}`).join("\n"),
    dsml.split("\n").map((line) => `\t${line}`).join("\n"),
    dsml.split("\n").map((line) => `\`${line}\``).join("\n"),
    "The format uses </｜DSML｜ parameter>, </｜DSML｜ invoke> and </｜DSML｜ calls>.",
    "</｜DSML｜ calls>",
    `${dsml}\nThese tags close the protocol envelope.`,
    dsml.replace("</｜DSML｜ invoke>", ""),
    dsml.replace("</｜DSML｜ calls>", ""),
  ])("leaves examples and ambiguous fragments alone", (text) => {
    expect(textToolCallDiagnostic(text, tools)).toBeUndefined();
  });
});
