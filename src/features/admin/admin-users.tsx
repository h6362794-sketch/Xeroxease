"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Input, Label, Modal, Select, Skeleton, Badge } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatDateShort, formatDateTimeLong } from "@/lib/utils";
import { Search, UserPlus, Ban, CheckCircle2, KeyRound } from "lucide-react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  regNo: string | null;
  branch: string | null;
  section: string | null;
  year: number | null;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function AdminUsers({ canManage }: { canManage: boolean }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [recoveryTarget, setRecoveryTarget] = useState<UserRow | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setUsers(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) params.set("q", q.trim());
      if (role !== "ALL") params.set("role", role);
      const data = await api<{ users: UserRow[]; total: number }>(`/api/admin/users?${params}`);
      setUsers(data.users);
      setTotal(data.total);
    } catch {
      setUsers([]);
    }
  }, [q, role, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 20));

  async function toggleActive(u: UserRow) {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: { isActive: !u.isActive } });
      toast(u.isActive ? `${u.name} disabled.` : `${u.name} enabled.`, "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Update failed.", "error");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Users</h1>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} icon={<UserPlus className="h-4 w-4" />}>
            Create admin
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input className="pl-10" placeholder="Name, email, reg no, phone…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search users" />
        </div>
        <Select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} aria-label="Role filter">
          <option value="ALL">All roles</option>
          <option value="STUDENT">Students</option>
          <option value="ADMIN">Admins</option>
          <option value="SUPER_ADMIN">Super admins</option>
        </Select>
      </div>

      {users === null ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
      ) : users.length === 0 ? (
        <Card><EmptyState title="No users found." /></Card>
      ) : (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/10">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Joined</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                  <td className="px-4 py-3">
                    <p className="text-white font-medium text-xs">{u.name}</p>
                    <p className="text-[11px] text-zinc-500">{u.regNo ?? u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={u.role === "STUDENT" ? "text-sky-300 bg-sky-500/10 border-sky-500/20" : "text-violet-300 bg-violet-500/10 border-violet-500/20"}>
                      {u.role.replaceAll("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={u.isActive ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20" : "text-red-300 bg-red-500/10 border-red-500/20"}>
                      {u.isActive ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{formatDateShort(u.createdAt)}</td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => toggleActive(u)}
                        icon={u.isActive ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      >
                        {u.isActive ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="ml-1"
                        onClick={() => setRecoveryTarget(u)}
                        icon={<KeyRound className="h-3.5 w-3.5" />}
                      >
                        Recovery code
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pages}</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      {createOpen && (
        <CreateAdminModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); load(); }}
        />
      )}

      {recoveryTarget && (
        <IssueRecoveryCodeModal
          user={recoveryTarget}
          onClose={() => setRecoveryTarget(null)}
        />
      )}
    </div>
  );
}

function CreateAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "", role: "ADMIN" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/users", { method: "POST", json: { ...form, phone: form.phone || undefined } });
      toast("Admin account created.", "success");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Creation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Create administrator">
      <p className="text-xs text-zinc-500 mb-4">
        Admin accounts are provisioned only here — there is no public admin signup.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="cname" required>Full name</Label>
          <Input id="cname" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
        </div>
        <div>
          <Label htmlFor="cemail" required>Email</Label>
          <Input id="cemail" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
        </div>
        <div>
          <Label htmlFor="cphone">Phone (optional)</Label>
          <Input id="cphone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="crole" required>Role</Label>
          <Select id="crole" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="cpass" required>Temporary password</Label>
          <Input id="cpass" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
          <p className="text-[11px] text-zinc-500 mt-1">8+ chars with upper, lower & a number. Share securely; user should change it.</p>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" loading={busy}>Create account</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Admin-assisted recovery.
 *
 * This is the fallback for a user who lost their password and never saved a
 * recovery code. It issues a single-use, 24-hour code that the administrator hands
 * to the user after verifying their identity in person.
 *
 * It deliberately does NOT set or reveal a password: the user chooses their own at
 * /forgot-password, and the administrator never sees it.
 */
function IssueRecoveryCodeModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) {
      setError("Confirm that you have verified this person's identity in person.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: true; code: string; expiresAt: string | null }>(
        `/api/admin/users/${user.id}/recovery-code`,
        { method: "POST", json: { reason } }
      );
      setCode(res.code);
      setExpiresAt(res.expiresAt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not issue a recovery code.");
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <Modal open onClose={onClose} title="Recovery code issued">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            Give this code to <span className="text-white font-semibold">{user.name}</span> ({user.regNo ?? user.email}).
            It works once and expires{" "}
            {expiresAt ? formatDateTimeLong(expiresAt) : "in 24 hours"}.
          </p>
          <p className="rounded-xl border border-zinc-700 bg-black/40 px-4 py-4 text-center font-mono text-base tracking-widest text-white break-all select-all">
            {code}
          </p>
          <p className="text-xs text-zinc-500">
            This code is shown once and is not stored anywhere in readable form. The request has been recorded in
            the audit log with the reason you gave.
          </p>
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`Issue a recovery code for ${user.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          Only do this after verifying this person&apos;s identity in person against their student ID. This code
          grants full control of the account.
        </div>

        <div>
          <Label htmlFor="reason" required>Reason (recorded in the audit log)</Label>
          <textarea
            id="reason"
            className="input min-h-[80px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Forgot password, no recovery code. Verified student ID 21A91A0501 at the counter."
            required
          />
        </div>

        <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
          />
          <span className="text-sm text-zinc-300">
            I have verified this person&apos;s identity in person.
          </span>
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={reason.trim().length < 5 || !confirmed}>
            Issue code
          </Button>
        </div>
      </form>
    </Modal>
  );
}
