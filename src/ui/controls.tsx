import type { JSX } from "@solidjs/web";
import { createEffect, omit } from "solid-js";
import { Icon, type IconName } from "./icons";

/**
 * An input showing `value` that never overwrites what's being typed: while
 * it has focus the text is the user's until they commit it (change) and
 * leave. Solid can apply an update late — one held back while an async
 * value (a preview) settles — and a plain `value` binding would then wipe
 * a half-typed entry.
 */
export function Field(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onBlur"> & { value: string | number }) {
  let el!: HTMLInputElement;
  const rest = omit(props, "value");
  createEffect(
    () => String(props.value),
    (v) => {
      if (document.activeElement !== el) el.value = v;
    },
  );
  return <input ref={el} {...rest} onBlur={() => (el.value = String(props.value))} />;
}

const clampTo = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Compact numeric input with a scrubbable label: drag the label horizontally
 * to change the value, as in Photoshop's options bar.
 */
export function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  width?: string;
  testId?: string;
  onChange: (v: number) => void;
}) {
  const commit = (v: number) => {
    if (Number.isFinite(v)) props.onChange(clampTo(v, props.min, props.max));
  };
  const scrub = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = props.value;
    const range = props.max - props.min;
    const perPx = (props.step ?? 1) * (range > 200 ? Math.max(1, range / 400) : 1);
    const move = (m: PointerEvent) => commit(Math.round((v0 + (m.clientX - x0) * perPx) / (props.step ?? 1)) * (props.step ?? 1));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <label class="flex items-center gap-1 whitespace-nowrap">
      <span class="cursor-ew-resize text-dim" onPointerDown={scrub}>
        {props.label}:
      </span>
      <Field
        type="number"
        class="text-right"
        style={{ width: props.width ?? "3.5rem" }}
        data-testid={props.testId}
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => commit(e.currentTarget.valueAsNumber)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {props.suffix && <span class="text-dim">{props.suffix}</span>}
    </label>
  );
}

export function IconButton(props: {
  icon: IconName;
  title: string;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active ? "true" : "false"}
      data-testid={props.testId}
      disabled={props.disabled}
      class={[
        "grid size-7 place-items-center rounded-sm text-fg/85 hover:bg-raised disabled:opacity-35 disabled:hover:bg-transparent",
        { "bg-accent-soft text-white hover:bg-accent-soft": !!props.active },
      ]}
      onClick={(e) => props.onClick(e)}
    >
      <Icon name={props.icon} />
    </button>
  );
}

export function Button(props: { children: JSX.Element; primary?: boolean; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      class={[
        "rounded-sm px-3 py-1 text-xs",
        props.primary ? "bg-accent text-white hover:brightness-110" : "bg-raised hover:brightness-125",
      ]}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

export function Separator() {
  return <div class="mx-1 h-5 w-px bg-line" />;
}
