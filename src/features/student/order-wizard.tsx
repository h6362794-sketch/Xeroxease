"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  UploadCloud, FileText, X, CheckCircle2, AlertTriangle, Loader2,
  ScanSearch, ArrowLeft, ArrowRight, Copy, Check,
} from "lucide-react";
import { Button, Card, Input, Label, Select, FieldError } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { cn, formatBytes, formatCurrencyINR } from "@/lib/utils";
import { MAX_FILES_PER_ORDER } from "@/lib/constants";
import {
  chooseUploadMode,
  exceedsUploadLimit,
  isUnsupportedDeployment,
  uploadDocumentDirect,
  type UploadCapability,
  type UploadIntent,
} from "@/lib/direct-upload";

/** Shape returned by POST /api/uploads/complete — the server-verified truth. */
type DirectCompleteResponse = { file: { id: string; originalName: string; sizeBytes: number; mimeType: string } };

interface FileItem {
  id: string;
  originalName: string;
  sizeBytes: number;
  pageCount: number | null;
  analysisStatus: string;
  analysisError?: string | null;
  source?: string | null;
}

const STEPS = ["Upload", "Analyze", "Configure", "Finish", "Review", "Pay", "Done"];

export function OrderWizard({ userId }: { userId: string }) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  // `null` = unknown yet. The direct path is the only one that can carry a 50 MB
  // document on a function host, so it is preferred whenever the deployment supports
  // it; `proxy` remains for local development (see /api/uploads/capability).
  const [uploadMode, setUploadMode] = useState<"direct" | "proxy" | null>(null);
  const [capability, setCapability] = useState<UploadCapability | null>(null);
  const inflight = useRef<Map<string, AbortController>>(new Map());
  // Set once a 501/503 from the intent endpoint has demoted this session to proxy
  // uploads, so we pay for that retry per session rather than per file.
  const demotedToProxy = useRef(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [config, setConfig] = useState({
    paperSize: "A4",
    colorMode: "" as "" | "BW" | "COLOR",
    sides: "SINGLE",
    copies: 1,
    pageSelection: "ALL" as "ALL" | "CUSTOM",
    customPages: "",
    finishing: [] as string[],
  });
  const [estimate, setEstimate] = useState<{ total: number; billablePages: number; pricePerPage: number; finishingFee: number } | null>(null);
  const [placing, setPlacing] = useState(false);
  const [order, setOrder] = useState<{ id: string; orderNumber: string; totalAmount: number } | null>(null);
  const [reference, setReference] = useState("");
  const [payState, setPayState] = useState<"WAITING" | "SUBMITTED">("WAITING");
  const [error, setError] = useState<string | null>(null);
  const [pageCountDraft, setPageCountDraft] = useState<Record<string, string>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await api<UploadCapability>("/api/uploads/capability");
        if (cancelled) return;
        setCapability(caps);
        setUploadMode(chooseUploadMode(caps));
      } catch {
        // Probe failed: keep the pre-existing behaviour rather than blocking uploads.
        if (cancelled) return;
        setUploadMode("proxy");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Closing the wizard must not leave a browser PUT streaming into storage for a file
  // the user has abandoned: abort everything still in flight (the intent then expires
  // and the object is swept).
  useEffect(() => {
    const controllers = inflight.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  const allAnalyzed = files.length > 0 && files.every((f) => f.analysisStatus === "COMPLETED" || f.analysisStatus === "NEEDS_REVIEW");
  const anyNeedsReview = files.some((f) => f.analysisStatus === "NEEDS_REVIEW" || f.analysisStatus === "FAILED");
  const allPrintable = files.length > 0 && files.every((f) => typeof f.pageCount === "number" && f.pageCount > 0);
  const canConfigure = allAnalyzed && allPrintable;

  // Server-side estimate via pricing API (client never computes final price)
  useEffect(() => {
    if (step !== 4 || !canConfigure) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        // We ask the server for the price table and replicate the visible estimate only.
        const data = await api<{ pricing: { key: string; unitPrice: number }[] }>("/api/pricing");
        const table: Record<string, number> = {};
        for (const p of data.pricing) table[p.key] = p.unitPrice;
        const totalPages = files.reduce((acc, f) => acc + (f.pageCount ?? 0), 0);
        const key = `${config.paperSize}_${config.colorMode === "COLOR" ? "COLOR" : "BW"}`;
        const perPage = table[key] ?? 0;
        const sheets = config.sides === "DOUBLE" ? Math.ceil(totalPages / 2) : totalPages;
        const billable = sheets * config.copies;
        const finishingFee = config.finishing.reduce((acc, f) => acc + (table[f] ?? 0), 0);
        setEstimate({ total: billable * perPage + finishingFee, billablePages: billable, pricePerPage: perPage, finishingFee });
      } catch {
        // estimate is best-effort
      }
    };
    load();
    return () => controller.abort();
  }, [step, canConfigure, files, config]);

  // Lets the student confirm a page count when automatic analysis was inconclusive
  // (legacy .doc, PDFs with an unreadable page tree, metadata-less .docx). Without
  // this the review state is a dead end and the order can never be placed.
  const confirmPageCount = async (fileId: string) => {
    const raw = (pageCountDraft[fileId] ?? "").trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
      toast("Enter a whole page count between 1 and 10000.", "error");
      return;
    }
    setConfirmingId(fileId);
    setError(null);
    try {
      await api<{ ok: boolean; pageCount: number }>(`/api/documents/${fileId}/pagecount`, {
        method: "PATCH",
        body: JSON.stringify({ pageCount: parsed }),
      });
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, pageCount: parsed, analysisStatus: "COMPLETED", analysisError: null, source: "USER_CONFIRMED" }
            : f
        )
      );
      setPageCountDraft((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
      toast("Page count confirmed.", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save the page count.", "error");
    } finally {
      setConfirmingId(null);
    }
  };

  const uploadViaProxy = useCallback(
    async (file: File): Promise<{ id: string; name: string; sizeBytes: number; analysisStatus: string }> => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api<{ file: { id: string; originalName: string; sizeBytes: number } }>("/api/uploads", {
        method: "POST",
        body: fd,
      });
      return { id: res.file.id, name: res.file.originalName, sizeBytes: res.file.sizeBytes, analysisStatus: "PENDING" };
    },
    []
  );

  const uploadOne = useCallback(
    async (
      file: File
    ): Promise<{ id: string; name: string; sizeBytes: number; analysisStatus: string }> => {
      const limit = capability?.maxBytes ?? 0;
      if (limit > 0 && exceedsUploadLimit(file.size, limit)) {
        throw new Error(`File exceeds the ${Math.floor(limit / (1024 * 1024))} MB limit.`);
      }

      if (uploadMode === "direct") {
        const controller = new AbortController();
        inflight.current.set(file.name, controller);
        let intent: UploadIntent;
        try {
          intent = await api<UploadIntent>("/api/uploads/intent", {
            method: "POST",
            json: { filename: file.name, mimeType: file.type, sizeBytes: file.size },
          });
        } catch (err) {
          inflight.current.delete(file.name);
          // A deployment that does not run this protocol should still accept the file
          // the way it always did — once, so a genuinely broken host does not retry on
          // every pick. Anything else propagates with the server's real message.
          if (isUnsupportedDeployment(err) && !demotedToProxy.current) {
            demotedToProxy.current = true;
            setUploadMode("proxy");
            return uploadViaProxy(file);
          }
          throw err;
        }
        try {
          // Server verifies size + signature after the transfer, so the completion
          // response — not the browser's File object — is what the list is built from.
          const { fileId, complete } = await uploadDocumentDirect<DirectCompleteResponse>(file, {
            requestIntent: async () => intent,
            reportComplete: (payload) => api<{ file: DirectCompleteResponse["file"] }>("/api/uploads/complete", { method: "POST", json: payload }),
            releaseIntent: (id) => api("/api/uploads/abort", { method: "POST", json: { fileId: id } }).catch(() => undefined),
            onProgress: (fraction) => setUploading({ name: file.name, progress: Math.round(fraction * 100) }),
            signal: controller.signal,
          });
          return {
            id: fileId,
            name: complete?.file?.originalName ?? file.name,
            sizeBytes: complete?.file?.sizeBytes ?? file.size,
            analysisStatus: "PENDING",
          };
        } finally {
          inflight.current.delete(file.name);
        }
      }

      return uploadViaProxy(file);
    },
    [capability, uploadMode, uploadViaProxy]
  );

  const uploadFiles = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      for (const f of arr) {
        if (files.length + arr.indexOf(f) >= MAX_FILES_PER_ORDER) {
          toast(`Up to ${MAX_FILES_PER_ORDER} files per order.`, "error");
          break;
        }
        setUploading({ name: f.name, progress: 5 });
        try {
          const result = await uploadOne(f);
          setFiles((prev) => [
            ...prev,
            {
              id: result.id,
              originalName: result.name,
              sizeBytes: result.sizeBytes,
              pageCount: null,
              analysisStatus: result.analysisStatus,
            },
          ]);
          setUploading({ name: f.name, progress: 100 });
        } catch (err) {
          toast(err instanceof ApiError || err instanceof Error ? err.message : "Upload failed. Please try again.", "error");
        }
      }
      setUploading(null);
    },
    [files.length, toast, uploadOne]
  );

  const runAnalysis = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      for (const f of files.filter((x) => x.analysisStatus === "PENDING" || x.analysisStatus === "PROCESSING")) {
        const res = await api<{ pageCount: number | null; status: string; source: string | null; error: string | null }>(
          "/api/documents/analyze",
          { method: "POST", json: { fileId: f.id } }
        );
        setFiles((prev) =>
          prev.map((p) =>
            p.id === f.id
              ? { ...p, pageCount: res.pageCount, analysisStatus: res.status, source: res.source, analysisError: res.error }
              : p
          )
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Analysis failed. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  const placeOrder = async () => {
    setPlacing(true);
    setError(null);
    try {
      const res = await api<{ order: { id: string; orderNumber: string; totalAmount: number } }>("/api/orders", {
        method: "POST",
        json: {
          fileIds: files.map((f) => f.id),
          paperSize: config.paperSize,
          colorMode: config.colorMode,
          sides: config.sides,
          copies: config.copies,
          pageSelection: config.pageSelection,
          customPages: config.pageSelection === "CUSTOM" ? config.customPages : undefined,
          finishing: config.finishing,
        },
      });
      setOrder(res.order);
      setStep(5);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not place the order. Please try again.");
    } finally {
      setPlacing(false);
    }
  };

  const submitReference = async () => {
    setError(null);
    try {
      await api(`/api/payment/submit/${order!.id}`, {
        method: "POST",
        json: { reference },
      });
      setPayState("SUBMITTED");
      setStep(6);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit payment reference.");
    }
  };

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const next = () => setStep((s) => Math.min(6, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const toggleFinishing = (opt: string) =>
    setConfig((c) => ({
      ...c,
      finishing: c.finishing.includes(opt) ? c.finishing.filter((x) => x !== opt) : [...c.finishing, opt],
    }));

  return (
    <div className="max-w-2xl mx-auto">
      {/* Progress indicator */}
      <ol className="flex items-center gap-1.5 mb-8" aria-label="Order progress">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <div className={cn("h-1.5 rounded-full transition-colors", i <= step ? "bg-[#7c5cff]" : "bg-white/10")} />
            <p className={cn("text-[10px] mt-1.5 font-medium truncate", i === step ? "text-white" : "text-zinc-600")}>{s}</p>
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          {/* STEP 0: UPLOAD */}
          {step === 0 && (
            <div className="space-y-5">
              <h1 className="text-xl font-extrabold text-white">Upload Documents</h1>
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload files"
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
                className={cn(
                  "border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60",
                  dragOver ? "border-[#7c5cff] bg-[#7c5cff]/10 scale-[1.01]" : "border-white/15 hover:border-white/30 hover:bg-white/[0.03]"
                )}
              >
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.ppt,.pptx"
                  className="hidden"
                  onChange={(e) => e.target.files && uploadFiles(e.target.files)}
                />
                {uploading ? (
                  <div className="space-y-3">
                    <Loader2 className="h-10 w-10 animate-spin text-[#b49aff] mx-auto" />
                    <p className="text-sm text-white font-medium truncate max-w-xs mx-auto">{uploading.name}</p>
                    <div className="h-1.5 w-48 mx-auto rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full bg-[#7c5cff] rounded-full transition-all" style={{ width: `${uploading.progress}%` }} />
                    </div>
                  </div>
                ) : (
                  <>
                    <UploadCloud className="h-10 w-10 text-zinc-500 mx-auto mb-3" />
                    <p className="text-sm font-semibold text-white">Drop files here or tap to browse</p>
                    <p className="text-xs text-zinc-500 mt-1.5">PDF, DOC, DOCX, PPT, PPTX · up to 50 MB each · max {MAX_FILES_PER_ORDER} files</p>
                  </>
                )}
              </div>

              {files.length > 0 && (
                <ul className="space-y-2">
                  {files.map((f) => (
                    <li key={f.id} className="card px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="h-5 w-5 text-zinc-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{f.originalName}</p>
                          <p className="text-xs text-zinc-500">{formatBytes(f.sizeBytes)}</p>
                        </div>
                      </div>
                      <button onClick={() => removeFile(f.id)} aria-label={`Remove ${f.originalName}`} className="rounded-lg p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex justify-end">
                <Button onClick={next} disabled={files.length === 0} icon={<ArrowRight className="h-4 w-4" />}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {/* STEP 1: ANALYZE */}
          {step === 1 && (
            <div className="space-y-5">
              <h1 className="text-xl font-extrabold text-white">AI Document Analysis</h1>
              <Card className="space-y-3">
                {analyzing || files.some((f) => f.analysisStatus === "PENDING") ? (
                  <div className="flex items-center gap-3 py-2">
                    <ScanSearch className="h-6 w-6 text-[#b49aff] animate-pulse" />
                    <div>
                      <p className="text-sm font-semibold text-white">Analyzing documents…</p>
                      <p className="text-xs text-zinc-500">Counting pages server-side. This takes a moment.</p>
                    </div>
                    <Loader2 className="h-5 w-5 animate-spin text-zinc-500 ml-auto" />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 py-2">
                    <CheckCircle2 className="h-6 w-6 text-emerald-400" />
                    <p className="text-sm font-semibold text-white">Analysis complete</p>
                  </div>
                )}
                {files.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3 border-t border-white/5 pt-3">
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{f.originalName}</p>
                      {f.analysisStatus === "NEEDS_REVIEW" || f.analysisStatus === "FAILED" ? (
                        <p className="text-xs text-amber-400 mt-0.5">
                          {f.analysisError || "Page count could not be automatically determined. Please verify the document or allow an administrator to review it."}
                        </p>
                      ) : null}
                    </div>
                    <div className="text-right shrink-0">
                      {f.analysisStatus === "COMPLETED" ? (
                        <span className="text-sm font-bold text-emerald-300">{f.pageCount} pages</span>
                      ) : f.analysisStatus === "PENDING" || f.analysisStatus === "PROCESSING" ? (
                        <Loader2 className="h-4 w-4 animate-spin text-zinc-500 ml-auto" />
                      ) : (
                        <div className="flex items-center justify-end gap-2 mt-1">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={10000}
                            step={1}
                            value={pageCountDraft[f.id] ?? ""}
                            onChange={(e) => setPageCountDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") confirmPageCount(f.id);
                            }}
                            aria-label={`Page count for ${f.originalName}`}
                            placeholder="Pages"
                            className="w-24 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sm text-white placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                          />
                          <Button size="sm" variant="ghost" onClick={() => confirmPageCount(f.id)} loading={confirmingId === f.id}>
                            Confirm
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
              {error && <FieldError message={error} />}
              {anyNeedsReview && !allPrintable && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-200">
                    Some documents need a page count before ordering. Enter the page count and press{" "}
                    <span className="font-semibold">Confirm</span>, remove the document, or contact the print
                    desk to have the count verified.
                  </p>
                </div>
              )}
              <div className="flex justify-between">
                <Button variant="ghost" onClick={back} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                {files.some((f) => f.analysisStatus === "PENDING") ? (
                  <Button onClick={runAnalysis} loading={analyzing}>Run analysis</Button>
                ) : (
                  <Button onClick={next} disabled={!canConfigure} icon={<ArrowRight className="h-4 w-4" />}>Continue</Button>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: CONFIGURE */}
          {step === 2 && (
            <div className="space-y-5">
              <h1 className="text-xl font-extrabold text-white">Configure Printing</h1>
              <Card className="space-y-5">
                <div>
                  <Label required>Colour</Label>
                  <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Colour mode">
                    {(["BW", "COLOR"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={config.colorMode === m}
                        onClick={() => setConfig((c) => ({ ...c, colorMode: m }))}
                        className={cn(
                          "rounded-xl border px-4 py-3.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60",
                          config.colorMode === m
                            ? "border-[#7c5cff] bg-[#7c5cff]/15 text-white"
                            : "border-white/10 text-zinc-400 hover:border-white/25"
                        )}
                      >
                        {m === "BW" ? "Black & White" : "Colour"}
                      </button>
                    ))}
                  </div>
                  {!config.colorMode && <p className="text-xs text-amber-400 mt-2">Colour selection is required to continue.</p>}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="paper" required>Paper Size</Label>
                    <Select id="paper" value={config.paperSize} onChange={(e) => setConfig((c) => ({ ...c, paperSize: e.target.value }))}>
                      <option value="A4">A4</option>
                      <option value="LEGAL">Legal</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="sides" required>Printing Side</Label>
                    <Select id="sides" value={config.sides} onChange={(e) => setConfig((c) => ({ ...c, sides: e.target.value }))}>
                      <option value="SINGLE">Single Side</option>
                      <option value="DOUBLE">Double Side</option>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="copies" required>Copies</Label>
                    <Input
                      id="copies" type="number" min={1} max={100}
                      value={config.copies}
                      onChange={(e) => setConfig((c) => ({ ...c, copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="pagesel" required>Page Selection</Label>
                    <Select id="pagesel" value={config.pageSelection} onChange={(e) => setConfig((c) => ({ ...c, pageSelection: e.target.value as "ALL" | "CUSTOM" }))}>
                      <option value="ALL">All pages</option>
                      <option value="CUSTOM">Custom pages</option>
                    </Select>
                  </div>
                </div>
                {config.pageSelection === "CUSTOM" && (
                  <div>
                    <Label htmlFor="custom" required>Custom page range</Label>
                    <Input
                      id="custom" placeholder="e.g. 1-5, 8, 10-15"
                      value={config.customPages}
                      onChange={(e) => setConfig((c) => ({ ...c, customPages: e.target.value }))}
                    />
                    <p className="text-[11px] text-zinc-500 mt-1">Applied to each document. Must fit within every file&apos;s page count.</p>
                  </div>
                )}
              </Card>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={back} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <Button onClick={next} disabled={!config.colorMode} icon={<ArrowRight className="h-4 w-4" />}>Continue</Button>
              </div>
            </div>
          )}

          {/* STEP 3: FINISHING */}
          {step === 3 && (
            <div className="space-y-5">
              <h1 className="text-xl font-extrabold text-white">Finishing Options</h1>
              <Card className="space-y-3">
                {[
                  { key: "STAPLE", label: "Staple", desc: "Corner stapled" },
                  { key: "SPIRAL", label: "Spiral Binding", desc: "Plastic spiral, lies flat" },
                  { key: "STICK_FILE", label: "Stick File", desc: "Mounted in a stick file" },
                ].map((opt) => {
                  const on = config.finishing.includes(opt.key);
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggleFinishing(opt.key)}
                      className={cn(
                        "w-full flex items-center justify-between rounded-xl border px-4 py-3.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60",
                        on ? "border-[#7c5cff] bg-[#7c5cff]/10" : "border-white/10 hover:border-white/25"
                      )}
                    >
                      <span className="text-left">
                        <span className="block text-sm font-semibold text-white">{opt.label}</span>
                        <span className="block text-xs text-zinc-500">{opt.desc}</span>
                      </span>
                      <span className={cn("rounded-lg p-1", on ? "bg-[#7c5cff] text-white" : "border border-white/20 text-transparent")}>
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  );
                })}
                <p className="text-[11px] text-zinc-500">Optional. Multiple selections are billed per item.</p>
              </Card>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={back} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <Button onClick={next} icon={<ArrowRight className="h-4 w-4" />}>Review order</Button>
              </div>
            </div>
          )}

          {/* STEP 4: REVIEW */}
          {step === 4 && (
            <div className="space-y-5">
              <h1 className="text-xl font-extrabold text-white">Review Order</h1>
              <Card className="space-y-4">
                <Row label="Documents" value={`${files.length} file(s) · ${files.reduce((a, f) => a + (f.pageCount ?? 0), 0)} pages`} />
                <Row label="Colour" value={config.colorMode === "COLOR" ? "Colour" : "Black & White"} />
                <Row label="Paper / Side" value={`${config.paperSize} · ${config.sides === "DOUBLE" ? "Double" : "Single"} side`} />
                <Row label="Copies" value={String(config.copies)} />
                <Row label="Pages" value={config.pageSelection === "CUSTOM" ? config.customPages : "All pages"} />
                <Row label="Finishing" value={config.finishing.length ? config.finishing.map((f) => f.replaceAll("_", " ")).join(", ") : "None"} />
                <div className="border-t border-white/10 pt-4 space-y-2">
                  {estimate && (
                    <>
                      <Row label={`Print (${estimate.billablePages} pages × ${formatCurrencyINR(estimate.pricePerPage)})`} value={formatCurrencyINR(estimate.billablePages * estimate.pricePerPage)} />
                      {estimate.finishingFee > 0 && <Row label="Finishing" value={formatCurrencyINR(estimate.finishingFee)} />}
                    </>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-white">Estimated total</span>
                    <span className="text-xl font-extrabold text-white">{estimate ? formatCurrencyINR(estimate.total) : "…"}</span>
                  </div>
                  <p className="text-[11px] text-zinc-500">Final price is calculated server-side from verified page counts.</p>
                </div>
              </Card>
              {error && <FieldError message={error} />}
              <div className="flex justify-between">
                <Button variant="ghost" onClick={back} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <Button onClick={placeOrder} loading={placing}>Place order</Button>
              </div>
            </div>
          )}

          {/* STEP 5: PAY */}
          {step === 5 && order && <PayStep order={order} reference={reference} setReference={setReference} onSubmit={submitReference} onDone={() => { setPayState("SUBMITTED"); setStep(6); }} error={error} />}

          {/* STEP 6: DONE */}
          {step === 6 && order && (
            <div className="text-center space-y-5 py-8">
              <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", damping: 14 }}>
                <CheckCircle2 className="h-16 w-16 text-emerald-400 mx-auto" />
              </motion.div>
              <h1 className="text-xl font-extrabold text-white">Order placed!</h1>
              <p className="text-sm text-zinc-400">
                {payState === "SUBMITTED"
                  ? "Your payment reference is under review. You'll be notified once the desk confirms it."
                  : "Complete the payment from your order page when you're ready."}
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="ghost" onClick={() => router.push("/dashboard")}>Dashboard</Button>
                <Button onClick={() => router.push(`/orders/${order.id}`)}>Track order</Button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="text-white font-medium text-right">{value}</span>
    </div>
  );
}

function PayStep({
  order, reference, setReference, onSubmit, onDone, error,
}: {
  order: { id: string; orderNumber: string; totalAmount: number };
  reference: string;
  setReference: (v: string) => void;
  onSubmit: () => void;
  onDone: () => void;
  error: string | null;
}) {
  const [qr, setQr] = useState<{ enabled: boolean; qrUrl?: string; instructions: string; accountDisplay: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ enabled: boolean; qrUrl?: string; instructions: string; accountDisplay: string }>("/api/payment/qr")
      .then(setQr)
      .catch(() => setQr({ enabled: false, instructions: "Contact the print desk for payment.", accountDisplay: "XeroxEase Print Desk" }));
  }, []);

  const amount = formatCurrencyINR(order.totalAmount);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-extrabold text-white">QR Payment</h1>
      <Card className="text-center space-y-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 font-semibold">Amount to pay</p>
          <p className="text-3xl font-extrabold text-white mt-1">{amount}</p>
          <p className="text-xs text-zinc-500 mt-1">Order {order.orderNumber}</p>
        </div>
        {qr?.enabled && qr.qrUrl ? (
          <div className="mx-auto w-fit rounded-2xl bg-white p-3 shadow-glow">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.qrUrl} alt="Payment QR code" className="h-52 w-52 object-contain" />
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            The payment QR is not configured yet. Please pay at the desk or check back shortly.
          </div>
        )}
        <p className="text-xs text-zinc-400 leading-relaxed max-w-sm mx-auto">{qr?.instructions}</p>
        <p className="text-xs text-zinc-500">{qr?.accountDisplay}</p>
      </Card>

      <Card className="space-y-4">
        <div>
          <Label htmlFor="ref" required>Transaction reference / UTR</Label>
          <div className="flex gap-2">
            <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. 402512345678" />
            <Button
              type="button" variant="ghost" onClick={() => { navigator.clipboard.writeText(order.orderNumber); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            >
              Copy order no.
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1.5">Found in your payment app&apos;s transaction history.</p>
        </div>
        {error && <FieldError message={error} />}
        <Button className="w-full" size="lg" onClick={onSubmit} loading={submitting} disabled={reference.trim().length < 4} onClickCapture={undefined}>
          I&apos;ve paid — submit for verification
        </Button>
        <p className="text-[11px] text-zinc-500 text-center">
          Payments are verified by the print desk. You&apos;ll be notified when confirmed — usually within minutes during working hours.
        </p>
        <button onClick={onDone} className="text-xs text-zinc-500 hover:text-zinc-300 underline mx-auto block">
          I&apos;ll pay later — go to my order
        </button>
      </Card>
    </div>
  );
}
