const { createHash } = require("node:crypto");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { errors } = require("appium/driver");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  ignoreDeclaration: true,
  processEntities: true,
  isArray: (name) => name === "node",
});

const NATIVE_ATTRIBUTES = Object.freeze({
  Android: Object.freeze({
    "content-desc": "string",
    "resource-id": "string",
    class: "string",
    package: "string",
    text: "string",
    bounds: "string",
    enabled: "boolean",
    checked: "boolean",
    checkable: "boolean",
    clickable: "boolean",
    focusable: "boolean",
    focused: "boolean",
    scrollable: "boolean",
    "long-clickable": "boolean",
    password: "boolean",
    selected: "boolean",
  }),
  iOS: Object.freeze({
    AXUniqueId: "string",
    AXLabel: "string",
    AXValue: "string",
    type: "string",
    enabled: "boolean",
  }),
});

function parseHierarchy(raw, platformName) {
  const source = raw.toString("utf8");
  const elements = [];
  const fail = () => {
    throw new errors.UnknownError(
      "Revyl returned an invalid native hierarchy.",
    );
  };
  const add = (node, rect, identifier, text, children, depth, visit) => {
    if (
      depth > 100 ||
      elements.length >= 10000 ||
      !node ||
      typeof node !== "object" ||
      Array.isArray(node)
    )
      fail();
    if (
      !Object.values(rect).every(Number.isFinite) ||
      rect.width < 0 ||
      rect.height < 0
    )
      fail();
    if (identifier != null && typeof identifier !== "string") fail();
    if (text != null && typeof text !== "string") fail();
    if (
      platformName === "Android"
        ? !["true", "false"].includes(node.enabled)
        : typeof node.enabled !== "boolean"
    )
      fail();
    const attributes = {};
    for (const [name, type] of Object.entries(
      NATIVE_ATTRIBUTES[platformName],
    )) {
      const value = node[name];
      if (value == null) {
        attributes[name] = null;
        continue;
      }
      if (
        type === "boolean"
          ? platformName === "Android"
            ? !["true", "false"].includes(value)
            : typeof value !== "boolean"
          : typeof value !== "string"
      )
        fail();
      attributes[name] = String(value);
    }
    const element = {
      identifier: identifier ?? "",
      text: text ?? "",
      rect: Object.freeze(rect),
      enabled: node.enabled === true || node.enabled === "true",
      editable:
        platformName === "Android"
          ? node.class === "android.widget.EditText"
          : ["TextField", "SecureTextField", "TextView"].includes(node.type),
      attributes: Object.freeze(attributes),
      index: elements.length,
    };
    elements.push(element);
    if (children !== undefined && !Array.isArray(children)) fail();
    for (const child of children ?? []) visit(child, depth + 1);
    element.subtreeEnd = elements.length;
    Object.freeze(element);
  };
  try {
    if (platformName === "Android") {
      const xml = source.replace(
        /(<\/hierarchy>)[\r\n]*UI hierchary dumped to: \/dev\/tty[\r\n]*$/,
        "$1",
      );
      if (
        /<!DOCTYPE|<!ENTITY/i.test(xml) ||
        XMLValidator.validate(xml) !== true
      )
        fail();
      const document = parser.parse(xml);
      if (!document.hierarchy || !Array.isArray(document.hierarchy.node))
        fail();
      const visit = (node, depth) => {
        const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(
          node.bounds,
        );
        if (!bounds) fail();
        const [, x, y, right, bottom] = bounds.map(Number);
        add(
          node,
          { x, y, width: right - x, height: bottom - y },
          node["content-desc"],
          node.text,
          node.node,
          depth,
          visit,
        );
      };
      for (const node of document.hierarchy.node) visit(node, 0);
    } else {
      const roots = JSON.parse(source);
      if (!Array.isArray(roots)) fail();
      const visit = (node, depth) => {
        if (!node?.frame) fail();
        const { x, y, width, height } = node.frame;
        const editable = ["TextField", "SecureTextField", "TextView"].includes(
          node.type,
        );
        add(
          node,
          { x, y, width, height },
          node.AXUniqueId,
          editable ? node.AXValue : (node.AXLabel ?? node.AXValue),
          node.children,
          depth,
          visit,
        );
      };
      for (const node of roots) visit(node, 0);
    }
  } catch {
    fail();
  }
  return Object.freeze({
    source,
    elements: Object.freeze(elements),
    fingerprint: createHash("sha256").update(source).digest("hex"),
  });
}

module.exports = { parseHierarchy, NATIVE_ATTRIBUTES };
