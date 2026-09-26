"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Input, Label, Modal, Select, Skeleton, Badge } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatDateShort } from "@/lib/utils";
import { Search, UserPlus, Ban, CheckCircle2 } from "lucide-react";

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
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => toggleActive(u)}
                        icon={u.isActive ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      >
                        {u.isActive ? "Disable" : "Enable"}
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
