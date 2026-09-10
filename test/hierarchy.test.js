const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseHierarchy } = require("../lib/hierarchy");

const androidNode = (attributes = "") =>
  `<node enabled="true" bounds="[10,20][110,60]" class="android.widget.EditText" ${attributes}/>`;
const iosNode = (overrides = {}) => ({
  AXUniqueId: "name-input",
  AXLabel: "Name",
  AXValue: "Revyl",
  type: "TextField",
  enabled: true,
  frame: { x: 10.5, y: 20, width: 100, height: 40 },
  ...overrides,
});

test("Android decodes XML entities and keeps pixel coordinates and exact IDs", () => {
  const { elements } = parseHierarchy(
    `<hierarchy>${androidNode('content-desc="Read &amp; write" text="Revyl"')}</hierarchy>`,
    "Android",
  );
  assert.deepEqual(elements, [
    {
      identifier: "Read & write",
      text: "Revyl",
      editable: true,
      enabled: true,
      rect: { x: 10, y: 20, width: 100, height: 40 },
    },
  ]);
});

test("iOS traverses nested IDB arrays and keeps fractional point coordinates", () => {
  const tree = [
    iosNode({
      children: [
        iosNode({
          AXUniqueId: "child",
          type: "Button",
          AXValue: "",
          AXLabel: "Continue",
        }),
      ],
    }),
  ];
  const { elements } = parseHierarchy(JSON.stringify(tree), "iOS");
  assert.equal(elements[0].text, "Revyl");
  assert.equal(elements[0].rect.x, 10.5);
  assert.equal(elements[1].text, "Continue");
  assert.equal(elements[1].editable, false);
  assert.equal(elements[1].identifier, "child");
});

for (const separator of ["", "\n", "\r\n"]) {
  test(`Android accepts only the known UIAutomator footer after XML (${JSON.stringify(separator)})`, () => {
    const xml = `<hierarchy>${androidNode('content-desc="name-input"')}</hierarchy>`;
    const { elements } = parseHierarchy(
      `${xml}${separator}UI hierchary dumped to: /dev/tty\n`,
      "Android",
    );
    assert.equal(elements[0].identifier, "name-input");
  });
}

for (const trailer of [
  "unknown output",
  "UI hierchary dumped to: /sdcard/window.xml",
  "UI hierchary dumped to: /dev/tty\nextra output",
  "UI hierchary dumped to: /dev/tty\nUI hierchary dumped to: /dev/tty",
]) {
  test(`Android rejects unexpected trailing output (${JSON.stringify(trailer)})`, () => {
    assert.throws(
      () =>
        parseHierarchy(
          `<hierarchy>${androidNode()}</hierarchy>${trailer}`,
          "Android",
        ),
      /invalid native hierarchy/,
    );
  });
}

test("Android still rejects malformed XML before the known footer", () => {
  assert.throws(
    () =>
      parseHierarchy(
        "<hierarchy><node></hierarchy>UI hierchary dumped to: /dev/tty",
        "Android",
      ),
    /invalid native hierarchy/,
  );
});

test("iOS does not substitute a label for a missing accessibility identifier", () => {
  const { elements } = parseHierarchy(
    JSON.stringify([iosNode({ AXUniqueId: null })]),
    "iOS",
  );
  assert.equal(elements[0].identifier, "");
});

test("fingerprints change when an element moves or its value changes", () => {
  const first = parseHierarchy(JSON.stringify([iosNode()]), "iOS");
  const moved = parseHierarchy(
    JSON.stringify([
      iosNode({ frame: { x: 30, y: 20, width: 100, height: 40 } }),
    ]),
    "iOS",
  );
  const edited = parseHierarchy(
    JSON.stringify([iosNode({ AXValue: "Changed" })]),
    "iOS",
  );
  assert.notEqual(first.fingerprint, moved.fingerprint);
  assert.notEqual(first.fingerprint, edited.fingerprint);
});

for (const [name, source, platform] of [
  ["malformed XML", "<hierarchy><node></hierarchy>", "Android"],
  [
    "XML entities",
    '<!DOCTYPE hierarchy [<!ENTITY secret "private">]><hierarchy/>',
    "Android",
  ],
  [
    "missing Android bounds",
    '<hierarchy><node enabled="true"/></hierarchy>',
    "Android",
  ],
  [
    "inverted Android bounds",
    '<hierarchy><node enabled="true" bounds="[100,100][10,20]"/></hierarchy>',
    "Android",
  ],
  [
    "missing Android enabled",
    '<hierarchy><node bounds="[0,0][10,20]"/></hierarchy>',
    "Android",
  ],
  ["Android missing root", "<node/>", "Android"],
  ["invalid iOS JSON", "private response, not JSON", "iOS"],
  ["iOS object instead of array", JSON.stringify(iosNode()), "iOS"],
  ["iOS null root", "[null]", "iOS"],
  ["missing iOS frame", JSON.stringify([iosNode({ frame: undefined })]), "iOS"],
  [
    "string iOS coordinates",
    JSON.stringify([
      iosNode({ frame: { x: "10", y: 20, width: 100, height: 40 } }),
    ]),
    "iOS",
  ],
  ["non-string iOS ID", JSON.stringify([iosNode({ AXUniqueId: 123 })]), "iOS"],
  ["non-string iOS text", JSON.stringify([iosNode({ AXValue: {} })]), "iOS"],
  [
    "non-array iOS children",
    JSON.stringify([iosNode({ children: {} })]),
    "iOS",
  ],
  [
    "invalid iOS enabled",
    JSON.stringify([iosNode({ enabled: "true" })]),
    "iOS",
  ],
]) {
  test(`rejects ${name} without returning hierarchy content`, () => {
    assert.throws(() => parseHierarchy(source, platform), {
      message: "Revyl returned an invalid native hierarchy.",
    });
  });
}

test("rejects excessively deep and oversized trees", () => {
  let nested = iosNode();
  for (let depth = 0; depth < 102; depth += 1)
    nested = iosNode({ children: [nested] });
  assert.throws(() => parseHierarchy(JSON.stringify([nested]), "iOS"));
  assert.throws(() =>
    parseHierarchy(
      JSON.stringify(Array.from({ length: 10001 }, () => iosNode())),
      "iOS",
    ),
  );
});
