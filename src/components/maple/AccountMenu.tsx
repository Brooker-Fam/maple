"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useAppNav } from "./AppNav";
import { Icon } from "./icons";
import SignOutButton from "./SignOutButton";
import { Avatar, cx } from "./ui";
import { useMaple } from "./useMaple";

const ITEM = "flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-medium outline-none hover:bg-mp-sunken focus-visible:bg-mp-sunken focus-visible:ring-2 focus-visible:ring-mp-focus disabled:opacity-40";

export default function AccountMenu() {
  const { state, memberName } = useMaple();
  const { go, tab, seg } = useAppNav();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => menu.current?.hidePopover();
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close();
    };
    window.addEventListener("hashchange", close);
    window.addEventListener("popstate", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", close);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("popstate", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => { menu.current?.hidePopover(); }, [tab, seg]);

  if (!state) return null;

  const close = () => menu.current?.hidePopover();
  const position = () => {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(272, window.innerWidth - 24);
    menu.current.style.width = `${width}px`;
    menu.current.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    menu.current.style.top = `${rect.bottom + 8}px`;
    menu.current.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 20)}px`;
  };
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      close();
      trigger.current?.focus();
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  const name = memberName(state.me.email);
  const role = state.me.role === "viewer" ? "View-only guest" : state.me.role === "owner" ? "Family owner" : "Family member";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none transition hover:bg-mp-sunken focus-visible:ring-2 focus-visible:ring-mp-focus focus-visible:ring-offset-2 focus-visible:ring-offset-mp-bg"
      >
        <Avatar member={state.me} size={34} />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Account menu"
        onBeforeToggle={(event) => {
          setOpen(event.newState === "open");
          if (event.newState === "open") position();
        }}
        onKeyDown={moveFocus}
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close();
        }}
        className="fixed inset-auto m-0 overflow-y-auto rounded-[20px] border border-mp-line bg-mp-surface p-2 text-mp-ink shadow-[0_12px_40px_rgb(0_0_0/0.14)]"
      >
        <div role="presentation" className="flex items-center gap-3 border-b border-mp-line px-3 pt-3 pb-4">
          <Avatar member={state.me} size={40} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{name}</p>
            <p className="mt-0.5 text-[13px] text-mp-ink-2">{role}</p>
          </div>
        </div>
        <button ref={(element) => { element?.setAttribute("autofocus", ""); }} type="button" role="menuitem" tabIndex={-1} onClick={() => { if (go("family")) close(); }} className={cx(ITEM, "mt-1")}>
          <Icon name="settings" size={20} className="text-mp-ink-2" />
          <span>Settings</span>
        </button>
        <SignOutButton role="menuitem" tabIndex={-1} onRequest={close} className={cx(ITEM, "text-mp-danger")}>
          <Icon name="arrow-right" size={20} />
        </SignOutButton>
      </div>
    </>
  );
}
