import Head from "next/head";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { RiCheckLine, RiCloseLine, RiMessage2Line, RiSendPlaneLine, RiMailLine } from "react-icons/ri";

interface ApprovalItem {
  id: string;
  pending_message: string | null;
  pending_subject: string | null;
  track: string;
  full_name: string | null;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  run_id: string;
  workflow_name: string;
  step_type: string;
}

const STEP_TYPE_ICONS: Record<string, React.ReactNode> = {
  message: <RiMessage2Line size={13} />,
  sales_inmail: <RiSendPlaneLine size={13} />,
  email: <RiMailLine size={13} />,
};

const STEP_TYPE_LABELS: Record<string, string> = {
  message: "LinkedIn Message",
  sales_inmail: "Sales Nav InMail",
  email: "Email",
};

const STEP_TYPE_COLORS: Record<string, string> = {
  message: "bg-success/10 text-success border-success/20",
  sales_inmail: "bg-primary/10 text-primary border-primary/20",
  email: "bg-warning/10 text-warning border-warning/20",
};

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editedMessages, setEditedMessages] = useState<Record<string, string>>({});
  const [editedSubjects, setEditedSubjects] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        const data = await res.json() as ApprovalItem[];
        setItems(data);
      }
    } catch {
      // silently ignore refresh errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 10_000);
    return () => clearInterval(interval);
  }, [fetchApprovals]);

  async function handleApprove(item: ApprovalItem) {
    if (submitting.has(item.id)) return;
    setSubmitting(prev => new Set(prev).add(item.id));
    try {
      const body: { message?: string; subject?: string } = {};
      if (editedMessages[item.id] !== undefined) body.message = editedMessages[item.id];
      if (editedSubjects[item.id] !== undefined) body.subject = editedSubjects[item.id];

      const res = await fetch(`/api/approvals/${item.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(`Approved message for ${item.full_name ?? "contact"}`);
        setItems(prev => prev.filter(i => i.id !== item.id));
        setEditedMessages(prev => { const n = { ...prev }; delete n[item.id]; return n; });
        setEditedSubjects(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      } else {
        toast.error("Failed to approve");
      }
    } catch {
      toast.error("Failed to approve");
    } finally {
      setSubmitting(prev => { const n = new Set(prev); n.delete(item.id); return n; });
    }
  }

  async function handleReject(item: ApprovalItem) {
    if (submitting.has(item.id)) return;
    setSubmitting(prev => new Set(prev).add(item.id));
    try {
      const res = await fetch(`/api/approvals/${item.id}/reject`, { method: "POST" });
      if (res.ok) {
        toast.success(`Rejected message for ${item.full_name ?? "contact"}`);
        setItems(prev => prev.filter(i => i.id !== item.id));
      } else {
        toast.error("Failed to reject");
      }
    } catch {
      toast.error("Failed to reject");
    } finally {
      setSubmitting(prev => { const n = new Set(prev); n.delete(item.id); return n; });
    }
  }

  return (
    <>
      <Head>
        <title>Approvals — Linki</title>
      </Head>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-base-content">Message Approvals</h1>
          <p className="text-sm text-base-content/50 mt-1">
            Review and approve messages before they are sent.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <span className="loading loading-spinner loading-sm text-base-content/30" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center mb-3">
              <RiCheckLine size={20} className="text-success" />
            </div>
            <p className="text-base-content/50 text-sm">No messages pending approval</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map(item => {
              const message = editedMessages[item.id] ?? item.pending_message ?? "";
              const subject = editedSubjects[item.id] ?? item.pending_subject ?? "";
              const hasSubject = item.pending_subject !== null;
              const busy = submitting.has(item.id);
              const stepColor = STEP_TYPE_COLORS[item.step_type] ?? "bg-base-300 text-base-content/50";

              return (
                <div key={item.id} className="bg-base-200 border border-base-300/50 rounded-xl p-5 flex flex-col gap-4">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-base-content">
                          {item.full_name ?? "Unknown Contact"}
                        </span>
                        <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border font-medium ${stepColor}`}>
                          {STEP_TYPE_ICONS[item.step_type]}
                          {STEP_TYPE_LABELS[item.step_type] ?? item.step_type}
                        </span>
                      </div>
                      {(item.title || item.company) && (
                        <p className="text-xs text-base-content/50">
                          {[item.title, item.company].filter(Boolean).join(" at ")}
                        </p>
                      )}
                      <p className="text-xs text-base-content/35 mt-0.5">{item.workflow_name}</p>
                    </div>
                  </div>

                  {/* Subject field (email / inmail) */}
                  {hasSubject && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-base-content/40 font-medium uppercase tracking-wider">Subject</label>
                      <input
                        type="text"
                        className="input input-sm bg-base-300/50 border border-base-300/60 rounded-lg text-sm w-full focus:outline-none focus:border-base-content/30"
                        value={subject}
                        onChange={e => setEditedSubjects(prev => ({ ...prev, [item.id]: e.target.value }))}
                        disabled={busy}
                      />
                    </div>
                  )}

                  {/* Message body */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-base-content/40 font-medium uppercase tracking-wider">Message</label>
                    <textarea
                      className="textarea bg-base-300/50 border border-base-300/60 rounded-lg text-sm w-full min-h-[120px] resize-y focus:outline-none focus:border-base-content/30"
                      value={message}
                      onChange={e => setEditedMessages(prev => ({ ...prev, [item.id]: e.target.value }))}
                      disabled={busy}
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <button
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-success/15 text-success border border-success/25 hover:bg-success/25 transition-colors disabled:opacity-50"
                      onClick={() => handleApprove(item)}
                      disabled={busy || !message.trim()}
                    >
                      {busy ? <span className="loading loading-spinner loading-xs" /> : <RiCheckLine size={14} />}
                      Approve
                    </button>
                    <button
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-base-300/60 text-base-content/50 border border-base-300/60 hover:bg-base-300 hover:text-base-content/70 transition-colors disabled:opacity-50"
                      onClick={() => handleReject(item)}
                      disabled={busy}
                    >
                      <RiCloseLine size={14} />
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
