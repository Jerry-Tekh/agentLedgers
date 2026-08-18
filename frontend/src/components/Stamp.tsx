import React from "react";

const STAMP_MAP: Record<string, { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "stamp-success" },
  unverified: { label: "Unverified", cls: "stamp-neutral" },
  active: { label: "Active", cls: "stamp-neutral" },
  completed: { label: "Completed", cls: "stamp-success" },
  rejected: { label: "Rejected", cls: "stamp-danger" },
  pending_review: { label: "Pending review", cls: "stamp-pending" },
  cancelled: { label: "Cancelled", cls: "stamp-neutral" },
};

export function Stamp({ status }: { status: string }) {
  const info = STAMP_MAP[status] ?? { label: status, cls: "stamp-neutral" };
  return <span className={`stamp ${info.cls}`}>{info.label}</span>;
}
