/**
 * Form fields read from the DOM, for what Playwright's accessibility tree doesn't give: the labels `snapshot -i` adds as hints, and `form`'s list of fields with their questions, values, required state and options. Pages often label a field with a `<div>` before it rather than a `<label>`, so the tree alone leaves it unnamed.
 */
import type { Page } from "playwright-core";

import {
  type AriaNode,
  FORM_CONTROLS,
  fullRef,
  LABEL_MAX,
  truncate,
} from "@/commands/snapshot";

/**
 * For form controls, the closest text before them in the page, read from the DOM: the label Playwright's accessibility tree doesn't give (a `<div>` before the input, a legend, the placeholder). Adds it as `hint`, unless it repeats the name. At most `MAX_HINTS` controls, so a big form doesn't slow the snapshot
 */
const MAX_HINTS = 40;

export async function addHints(page: Page, nodes: AriaNode[]): Promise<void> {
  const targets: AriaNode[] = [];
  const walk = (list: AriaNode[]) => {
    for (const node of list) {
      if (node.ref && FORM_CONTROLS.has(node.role) && node.role !== "radio")
        targets.push(node);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  await Promise.all(
    targets.slice(0, MAX_HINTS).map(async (node) => {
      try {
        const found = await page
          .locator(`aria-ref=${fullRef(page, node.ref as string)}`)
          .evaluate(readField, undefined, { timeout: 2_000 });
        const clean = (text: string) => text.replace(/\s+/g, " ").trim();
        const hint = clean(found.hint);
        const question = clean(found.question);
        if (hint && hint !== node.name)
          node.hint = JSON.stringify(truncate(hint, LABEL_MAX));
        if (question && question !== node.name && question !== hint)
          node.question = JSON.stringify(truncate(question, LABEL_MAX));
      } catch {
        // A control that moved or went away has no hint
      }
    }),
  );
}

/** A form field for `form`: its ref and role from the snapshot, the rest read from the DOM */
export type FormField = {
  ref: string;
  role: string;
  label: string;
  question: string;
  value: string;
  required: boolean;
  invalid: boolean;
  disabled: boolean;
  /** Native select options, or a radio group's radios (`label` and `ref`) */
  options: { label: string; ref?: string; selected: boolean }[];
};
export type FormButton = { ref: string; name: string; question: string };

const MAX_FIELDS = 80;
/** A label ending in `*`, maybe followed by an icon's ligature (`Go-Live Date * help`) */
const REQUIRED_MARK = /\*\s*(?:[a-z_]{2,24})?\s*$/;
/** Buttons that add a row of fields ("ADD MORE", "Add", "+") */
const ADD_BUTTON = /^(\+|add|add more|add row|add another|add item)$/i;

/** The fields and add-row buttons in the snapshot, in page order, read from the DOM (at most `MAX_FIELDS`) */
export async function formFields(
  page: Page,
  nodes: AriaNode[],
): Promise<{ fields: FormField[]; buttons: FormButton[]; more: number }> {
  const controls: AriaNode[] = [];
  const buttons: AriaNode[] = [];
  const walk = (list: AriaNode[], inGroup: boolean) => {
    for (const node of list) {
      const isField =
        node.ref &&
        FORM_CONTROLS.has(node.role) &&
        !(node.role === "radio" && inGroup);
      if (isField) controls.push(node);
      if (
        node.ref &&
        node.role === "button" &&
        ADD_BUTTON.test(node.name ?? "")
      )
        buttons.push(node);
      // A radiogroup lists its radios as options, so they aren't fields of their own
      if (node.role !== "listbox")
        walk(node.children ?? [], inGroup || node.role === "radiogroup");
    }
  };
  walk(nodes, false);
  const read = async (node: AriaNode) => {
    try {
      return await page
        .locator(`aria-ref=${fullRef(page, node.ref as string)}`)
        .evaluate(readField, undefined, { timeout: 2_000 });
    } catch {
      return null;
    }
  };
  const clean = (text: string) =>
    truncate(text.replace(/\s+/g, " ").trim(), LABEL_MAX) ?? "";
  const fields = (
    await Promise.all(
      controls
        .slice(0, MAX_FIELDS)
        .map(async (node): Promise<FormField | null> => {
          const dom = await read(node);
          if (!dom) return null;
          const radios =
            node.role === "radiogroup"
              ? collectRadios(node.children ?? []).map((radio) => ({
                  label: radio.name ?? "",
                  ref: radio.ref,
                  selected: radio.checked === true,
                }))
              : [];
          const options = radios.length ? radios : dom.options;
          const label = clean(node.name || dom.hint);
          return {
            ref: node.ref as string,
            role: node.role,
            label,
            question: clean(dom.question),
            value: clean(fieldValue(node, radios, dom.value)),
            required:
              dom.required ||
              [dom.hint, dom.question, node.name ?? ""].some((text) =>
                REQUIRED_MARK.test(text),
              ),
            invalid: dom.invalid || node.invalid === true,
            disabled: dom.disabled || node.disabled === true,
            options,
          };
        }),
    )
  ).filter((field): field is FormField => field !== null);
  const buttonInfo = await Promise.all(
    buttons.map(async (node) => ({
      ref: node.ref as string,
      name: node.name ?? "",
      question: clean((await read(node))?.question ?? ""),
    })),
  );
  return {
    fields,
    buttons: buttonInfo,
    more: Math.max(0, controls.length - MAX_FIELDS),
  };
}

/** A field's value: the checked radio, the checkbox state, a listbox's options, else the DOM's value, with a select's placeholder ("Select a…") as empty */
function fieldValue(
  node: AriaNode,
  radios: { label: string; selected: boolean }[],
  domValue: string,
): string {
  if (node.role === "radiogroup")
    return radios.find((radio) => radio.selected)?.label ?? "";
  if (node.role === "checkbox" || node.role === "switch")
    return node.checked === true ? "checked" : "unchecked";
  if (node.role === "listbox") {
    return (node.children ?? [])
      .filter((child) => child.role === "option")
      .map((child) => child.name ?? "")
      .filter(Boolean)
      .join("; ");
  }
  if (
    node.role === "combobox" &&
    /^(select|choose|pick)\b/i.test(domValue.trim())
  )
    return "";
  return domValue;
}

function collectRadios(list: AriaNode[]): AriaNode[] {
  return list.flatMap((node) =>
    node.role === "radio" && node.ref
      ? [node]
      : collectRadios(node.children ?? []),
  );
}

/** Runs in the page: what the accessibility tree doesn't say about a field. Its label (`hint`): its own `<label>`, else the closest text before it, else its placeholder. Its question: the closest visible `<label>`, `<legend>` or heading before it, which a group of fields answers */
function readField(el: Element): {
  hint: string;
  question: string;
  value: string;
  required: boolean;
  invalid: boolean;
  disabled: boolean;
  options: { label: string; selected: boolean }[];
} {
  const lastLine = (node: Element | null) =>
    ((node as HTMLElement | null)?.innerText ?? node?.textContent ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const input = el as HTMLInputElement;
  // The question: the closest visible label, legend or heading before the field
  let question = "";
  const labels = document.querySelectorAll(
    "label, legend, h1, h2, h3, h4, h5, h6",
  );
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i];
    if (
      label !== el &&
      !label.contains(el) &&
      el.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_PRECEDING &&
      (label as HTMLElement).offsetParent &&
      lastLine(label)
    ) {
      question = lastLine(label);
      break;
    }
  }
  // The label: the field's own label, else the closest text before it
  let hint = lastLine(input.labels?.[0] ?? null);
  for (
    let current: Element | null = el, depth = 0;
    !hint && current && depth < 14;
    depth++
  ) {
    for (
      let sibling = current.previousElementSibling;
      sibling && !hint;
      sibling = sibling.previousElementSibling
    ) {
      const value = lastLine(sibling);
      if (value && !sibling.querySelector("input,select,textarea"))
        hint = value;
    }
    current = current.parentElement;
  }
  hint ||= input.placeholder ?? "";
  // Only the field's own wrapper: a form or group marked invalid says nothing about this field
  const wrapper = el.closest("mat-form-field, .mat-mdc-form-field");
  const select = el instanceof HTMLSelectElement ? el : null;
  const value =
    "value" in input &&
    typeof input.value === "string" &&
    el.tagName !== "BUTTON"
      ? input.value
      : ((el as HTMLElement).innerText ?? "");
  return {
    hint,
    question,
    value: select
      ? (select.selectedOptions[0]?.label ?? "")
      : input.type === "password" && value
        ? "(hidden)"
        : value,
    required:
      input.required === true ||
      el.getAttribute("aria-required") === "true" ||
      !!el.closest("[required], [aria-required=true]"),
    invalid:
      el.getAttribute("aria-invalid") === "true" ||
      (input.validity ? !input.validity.valid : false) ||
      !!wrapper?.classList.contains("mat-form-field-invalid"),
    disabled:
      input.disabled === true || el.getAttribute("aria-disabled") === "true",
    options: select
      ? [...select.options].slice(0, 30).map((option) => ({
          label: option.label,
          selected: option.selected,
        }))
      : [],
  };
}

/** `form`'s output: fields grouped under the question they answer, `!` before required fields that are still empty */
export function renderForm(form: {
  fields: FormField[];
  buttons: FormButton[];
  more: number;
}): string {
  if (!form.fields.length) return "(no form fields)";
  const lines: string[] = [];
  const missing = form.fields.filter((field) => field.required && !field.value);
  lines.push(
    `${form.fields.length} fields${missing.length ? `, ${missing.length} required still empty (!)` : ""}`,
  );
  let question: string | null = null;
  const addButtons = (forQuestion: string | null) => {
    for (const button of form.buttons) {
      if (button.question === (forQuestion ?? ""))
        lines.push(
          `  + ${JSON.stringify(button.name)} [ref=${button.ref}] adds a row`,
        );
    }
  };
  for (const field of form.fields) {
    if (field.question !== question) {
      if (question !== null) addButtons(question);
      question = field.question;
      if (question) lines.push(`? ${question}`);
    }
    const flags = [
      field.required ? "required" : "",
      field.invalid ? "invalid" : "",
      field.disabled ? "disabled" : "",
    ].filter(Boolean);
    let line = `  ${field.required && !field.value ? "!" : "-"} ${field.role}`;
    if (field.label && field.label !== question)
      line += ` ${JSON.stringify(field.label)}`;
    line += ` [ref=${field.ref}]`;
    if (flags.length) line += ` [${flags.join(", ")}]`;
    line += field.value ? ` = ${JSON.stringify(field.value)}` : " (empty)";
    lines.push(line);
    if (field.options.length) {
      lines.push(
        `      options: ${field.options
          .map(
            (option) =>
              `${option.selected ? "●" : "○"} ${option.label}${option.ref ? ` [ref=${option.ref}]` : ""}`,
          )
          .join(" | ")}`,
      );
    }
  }
  addButtons(question);
  if (form.more)
    lines.push(
      `… ${form.more} more fields: use \`form <target>\` to narrow it`,
    );
  return lines.join("\n");
}
