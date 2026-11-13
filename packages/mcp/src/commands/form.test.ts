import { describe, expect, it } from "vitest";

import { type FormField, renderForm } from "@/commands/form";

describe("renderForm", () => {
  const field = (extra: Partial<FormField>): FormField => ({
    ref: "e1",
    role: "textbox",
    label: "",
    question: "",
    value: "",
    required: false,
    invalid: false,
    disabled: false,
    options: [],
    ...extra,
  });

  it("groups fields by question, marking required empty fields and add-row buttons", () => {
    expect(
      renderForm({
        fields: [
          field({
            ref: "e2",
            role: "radiogroup",
            question: "Is this a Release SA? *",
            required: true,
            options: [
              { label: "Yes", ref: "e3", selected: false },
              { label: "No", ref: "e4", selected: false },
            ],
          }),
          field({
            ref: "e5",
            question: "PR links *",
            label: "PR link",
            value: "https://x/pull/1",
          }),
          field({
            ref: "e6",
            question: "PR links *",
            required: true,
            invalid: true,
          }),
        ],
        buttons: [{ ref: "e7", name: "add", question: "PR links *" }],
        more: 0,
      }),
    ).toBe(`3 fields, 2 required still empty (!)
? Is this a Release SA? *
  ! radiogroup [ref=e2] [required] (empty)
      options: ○ Yes [ref=e3] | ○ No [ref=e4]
? PR links *
  - textbox "PR link" [ref=e5] = "https://x/pull/1"
  ! textbox [ref=e6] [required, invalid] (empty)
  + "add" [ref=e7] adds a row`);
  });

  it("says when there are no fields", () => {
    expect(renderForm({ fields: [], buttons: [], more: 0 })).toBe(
      "(no form fields)",
    );
  });
});
