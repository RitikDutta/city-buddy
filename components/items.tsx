"use client";
import { useRef, useState, type FormEvent } from "react";
import { Check, Pencil, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { type Item, type ItemValues } from "@/lib/contracts";
import { api, errorText } from "@/lib/client/api";
import { ErrorNote, Modal, Spinner } from "./ui";
import { useWorkspace } from "./workspace";
import { ChatRoom } from "./talk";

function EditItem({
  item,
  close,
  save,
}: {
  item: Item;
  close: () => void;
  save: (values: ItemValues) => Promise<void>;
}) {
  const [values, setValues] = useState<ItemValues>({
    name: item.name,
    quantity: item.quantity,
    notes: item.notes,
    status: item.status,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save(values);
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Edit item" close={close}>
      <form className="edit-form" onSubmit={submit}>
        <label>
          Item name
          <input
            required
            maxLength={160}
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
        </label>
        <div className="edit-pair">
          <label>
            Quantity
            <input
              type="number"
              required
              min="1"
              max="9999"
              value={values.quantity}
              onChange={(e) =>
                setValues({ ...values, quantity: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Status
            <select
              value={values.status}
              onChange={(e) =>
                setValues({
                  ...values,
                  status: e.target.value as Item["status"],
                })
              }
            >
              <option value="pending">Pending</option>
              <option value="purchased">Purchased</option>
              <option value="skipped">Skipped</option>
            </select>
          </label>
        </div>
        <label>
          Notes
          <textarea
            rows={3}
            value={values.notes}
            maxLength={1200}
            onChange={(e) => setValues({ ...values, notes: e.target.value })}
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy && <Spinner />}Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ItemsPage({ sessionId }: { sessionId?: string }) {
  return (
    <ChatRoom
      mode="my_items"
      sessionId={sessionId}
      checklist={<ItemsChecklist />}
    />
  );
}

function ItemsChecklist() {
  const { data, refresh } = useWorkspace();
  const [filter, setFilter] = useState<"all" | Item["status"]>("all");
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const addRequestId = useRef<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Item | null>(null);
  const items = data?.items ?? [];
  const filtered =
    filter === "all" ? items : items.filter((i) => i.status === filter);
  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="checklist-content">
      <section className="item-entry">
        <h2>Add an item</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void act("add", async () => {
              await api("items", "POST", {
                name: name.trim(),
                quantity: Number(qty),
                requestId: (addRequestId.current ??= crypto.randomUUID()),
              });
              addRequestId.current = null;
              setName("");
              setQty("1");
              setFilter("all");
            });
          }}
        >
          <label className="name-input">
            <span>Item name</span>
            <input
              placeholder="What do you need?"
              value={name}
              maxLength={160}
              required
              onChange={(e) => {
                addRequestId.current = null;
                setName(e.target.value);
              }}
            />
          </label>
          <label className="qty-input">
            <span>Quantity</span>
            <input
              type="number"
              value={qty}
              min={1}
              max={9999}
              required
              onChange={(e) => {
                addRequestId.current = null;
                setQty(e.target.value);
              }}
            />
          </label>
          <button className="primary" disabled={!data || !!busy}>
            {busy === "add" ? <Spinner /> : <Plus size={18} />}Add item
          </button>
        </form>
      </section>
      <section>
        <div className="section-heading">
          <h3>Items</h3>
          <span className="count">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </div>
        <div className="filter-bar">
          {(["all", "pending", "purchased", "skipped"] as const).map((v) => (
            <button
              className={v === filter ? "active" : ""}
              key={v}
              onClick={() => setFilter(v)}
              aria-pressed={v === filter}
            >
              {v === "all"
                ? "All items"
                : v === "pending"
                  ? "Pending"
                  : v === "skipped"
                    ? "Skipped"
                    : "Purchased"}
            </button>
          ))}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          <div className="soft-empty">
            <Spinner />
            Loading checklist…
          </div>
        ) : filtered.length ? (
          <ul className="items-list">
            {filtered.map((i) => (
              <li
                key={i.id}
                className={i.status === "purchased" ? "purchased" : ""}
              >
                <button
                  className="item-check"
                  role="checkbox"
                  aria-checked={i.status === "purchased"}
                  aria-label={
                    "Mark " +
                    i.name +
                    (i.status === "purchased" ? " as pending" : " as purchased")
                  }
                  disabled={!!busy}
                  onClick={() =>
                    void act(i.id, () =>
                      api("items/" + i.id, "PATCH", {
                        status:
                          i.status === "purchased" ? "pending" : "purchased",
                      }),
                    )
                  }
                >
                  {i.status === "purchased" && <Check size={15} />}
                </button>
                <div className="item-name">
                  <strong>{i.name}</strong>
                  {i.notes && <p>{i.notes}</p>}
                  <small>
                    Quantity {i.quantity} ·{" "}
                    {i.status === "purchased"
                      ? "Purchased"
                      : i.status === "skipped"
                        ? "Skipped"
                        : "Pending"}
                  </small>
                </div>
                <button
                  className="icon-button"
                  aria-label={"Edit " + i.name}
                  disabled={!!busy}
                  onClick={() => setEditing(i)}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button delete"
                  aria-label={"Delete " + i.name}
                  disabled={!!busy}
                  onClick={() =>
                    void act(i.id, () => api("items/" + i.id, "DELETE"))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="panel empty">
            <span className="empty-icon my_items">
              <ShoppingBag size={27} />
            </span>
            <h3>
              {filter === "all"
                ? "Your checklist is empty"
                : "No " + filter + " items"}
            </h3>
            <p>
              {filter === "all"
                ? "Add your first item above. CityBuddy can help you find it nearby."
                : "Items with this status will appear here."}
            </p>
          </div>
        )}
      </section>
      {editing && (
        <EditItem
          item={editing}
          close={() => setEditing(null)}
          save={async (values) => {
            await api("items/" + editing.id, "PATCH", values);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
