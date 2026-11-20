"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  AlertCircle,
  Landmark,
  LoaderCircle,
  MessagesSquare,
  ShoppingBag,
  X,
} from "lucide-react";
import type { Mode } from "@/lib/contracts";

export const modeIcons = {
  my_items: ShoppingBag,
  live_talk: MessagesSquare,
  on_site_guide: Landmark,
} as const;
export const modeArt: Record<Mode, string> = {
  my_items: "/art/market.webp",
  live_talk: "/art/cafe.webp",
  on_site_guide: "/art/gateway.webp",
};
export function Spinner() {
  return <LoaderCircle size={17} className="spin" aria-hidden="true" />;
}
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="error-note" role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <div className="modal-head">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
