import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileSpreadsheet,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { api, money, useApi } from "../api";
import { Badge, DataTable, ErrorBox, PageHeader, Panel } from "../components";
import { P, can, useUser } from "../access";

const flow = ["Upload", "Analyze", "Preview", "Resolve", "Import", "Results"];
const selectableActions = new Set(["CREATE", "UPDATE_EXISTING"]);

function rowSelectable(row) {
  return selectableActions.has(row.action) && !row.inFileDuplicate;
}

function actionLabel(row, ready) {
  if (row.action === "IGNORE_DELIVERED") return "Ignore delivered";
  if (row.action === "DUPLICATE" || row.inFileDuplicate)
    return "Skip duplicate";
  if (row.action === "INVALID") return "Skip invalid";
  if (
    row.existingOrderId &&
    !(
      (row.existingStatus !== row.mappedStatus && row.existingCanUpdate) ||
      (row.existingStatus === row.mappedStatus && row.feeRequired)
    )
  )
    return "Skip status conflict";
  if (!ready) return "Resolve mapping";
  return row.existingOrderId ? "Update existing" : "Import";
}

export function ImportData() {
  const user = useUser();
  const history = useApi("/imports/orders/history");
  const inputRef = useRef(null);
  const analysisRequest = useRef(0);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [productMappings, setProductMappings] = useState({});
  const [wilayaMappings, setWilayaMappings] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  const phase = result ? 5 : preview ? 3 : file ? 1 : 0;
  const catalogById = useMemo(
    () =>
      new Map(
        (preview?.catalogOptions || []).map((item) => [String(item._id), item]),
      ),
    [preview],
  );

  function chooseFile(next) {
    if (!next) return;
    const requestId = ++analysisRequest.current;
    if (!/\.xlsx?$/i.test(next.name)) {
      setBusy(false);
      setError("Choose an .xls or .xlsx file.");
      return;
    }
    setFile(next);
    setPreview(null);
    setResult(null);
    setProductMappings({});
    setWilayaMappings({});
    setSelected(new Set());
    setError("");
    void analyze(next, requestId);
  }

  async function analyze(
    targetFile = file,
    requestId = ++analysisRequest.current,
  ) {
    if (!targetFile) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", targetFile);
      const data = await api("/imports/orders/preview", {
        method: "POST",
        body,
      });
      if (requestId !== analysisRequest.current) return;
      setPreview(data);
      setProductMappings(
        Object.fromEntries(
          data.productMappings.map((mapping) => [
            mapping.key,
            mapping.items.map((item) => ({
              business: item.business,
              catalogItemId: String(item.catalogItemId),
              quantity: item.quantity,
            })),
          ]),
        ),
      );
      setWilayaMappings(
        Object.fromEntries(
          data.wilayaMappings
            .filter((mapping) => mapping.wilayaId)
            .map((mapping) => [mapping.key, mapping.wilayaId]),
        ),
      );
      setSelected(
        new Set(data.rows.filter(rowSelectable).map((row) => row.rowNumber)),
      );
    } catch (caught) {
      if (requestId === analysisRequest.current) setError(caught.message);
    } finally {
      if (requestId === analysisRequest.current) setBusy(false);
    }
  }

  function rowReady(row) {
    const items = productMappings[row.productMappingKey] || [];
    const existingAllowed =
      !row.existingOrderId ||
      (row.existingStatus !== row.mappedStatus && row.existingCanUpdate) ||
      (row.existingStatus === row.mappedStatus && row.feeRequired);
    return (
      !row.errors.length &&
      !row.inFileDuplicate &&
      row.action !== "IGNORE_DELIVERED" &&
      row.action !== "DUPLICATE" &&
      row.action !== "INVALID" &&
      existingAllowed &&
      items.length > 0 &&
      items.every(
        (item) =>
          catalogById.has(String(item.catalogItemId)) && item.quantity > 0,
      ) &&
      Boolean(wilayaMappings[row.wilayaMappingKey])
    );
  }

  function toggleRow(rowNumber) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  function selectAllImportable() {
    setSelected(
      new Set(preview.rows.filter(rowSelectable).map((row) => row.rowNumber)),
    );
  }

  function addProductItem(key) {
    const option = preview.catalogOptions[0];
    if (!option) return;
    setProductMappings((current) => ({
      ...current,
      [key]: [
        ...(current[key] || []),
        {
          business: option.business,
          catalogItemId: option._id,
          quantity: 1,
        },
      ],
    }));
  }

  function updateProductItem(key, index, patch) {
    setProductMappings((current) => ({
      ...current,
      [key]: current[key].map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    }));
  }

  function removeProductItem(key, index) {
    setProductMappings((current) => ({
      ...current,
      [key]: current[key].filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function commit() {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append(
        "options",
        JSON.stringify({
          selectedRows: preview.rows
            .filter((row) => selected.has(row.rowNumber))
            .map((row) => row.rowNumber),
          productMappings,
          wilayaMappings,
        }),
      );
      const data = await api("/imports/orders/commit", {
        method: "POST",
        body,
      });
      setResult(data);
      history.reload();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  const liveEligible = preview
    ? preview.rows.filter((row) => rowReady(row)).length
    : 0;
  const selectedReady = preview
    ? preview.rows.filter((row) => selected.has(row.rowNumber) && rowReady(row))
        .length
    : 0;
  const selectedCount = preview
    ? preview.rows.filter((row) => selected.has(row.rowNumber)).length
    : 0;
  const selectedNeedResolution = selectedCount - selectedReady;
  const unresolvedProducts = preview
    ? preview.productMappings.filter(
        (mapping) => !(productMappings[mapping.key] || []).length,
      ).length
    : 0;
  const unresolvedWilayas = preview
    ? preview.wilayaMappings.filter((mapping) => !wilayaMappings[mapping.key])
        .length
    : 0;
  const manualProductMappings = preview
    ? preview.productMappings.filter((mapping) => mapping.needsMapping)
    : [];
  const manualWilayaMappings = preview
    ? preview.wilayaMappings.filter((mapping) => mapping.needsMapping)
    : [];

  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE / SETTINGS / IMPORT DATA"
        title="Bring external orders into the workspace."
        description="Analyze LOGIX and TAMQO Excel exports, resolve mappings, then import only the rows you approve."
      />

      <ol className="import-flow" aria-label="Import progress">
        {flow.map((label, index) => (
          <li key={label} className={index <= phase ? "active" : ""}>
            <span>{index < phase ? <Check size={14} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <ErrorBox error={error} />

      <Panel
        title="Upload Excel"
        subtitle="Accepted formats: .xls and .xlsx. Files are parsed on the server and are not retained."
      >
        <button
          type="button"
          className={`import-dropzone ${dragging ? "dragging" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            chooseFile(event.dataTransfer.files[0]);
          }}
        >
          <Upload size={28} />
          <strong>{file ? file.name : "Drop an Excel file here"}</strong>
          <span>
            {file ? `${(file.size / 1024).toFixed(1)} KB` : "or choose a file"}
          </span>
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept=".xls,.xlsx"
          onChange={(event) => {
            const next = event.target.files[0];
            event.target.value = "";
            chooseFile(next);
          }}
        />
        <div className="import-actions">
          <button onClick={() => inputRef.current?.click()}>Choose file</button>
          <button disabled={!file || busy} onClick={() => analyze()}>
            <FileSpreadsheet size={16} />
            {busy && !preview ? "Analyzing…" : "Re-analyze"}
          </button>
        </div>
      </Panel>

      {preview && (
        <>
          <Panel
            title="Preview summary"
            subtitle={`${preview.filename} · ${liveEligible} rows currently eligible`}
          >
            <div className="import-summary">
              {[
                ["Total rows", preview.summary.totalRows],
                ["Eligible for import", liveEligible],
                ["Delivered ignored", preview.summary.deliveredIgnored],
                ["Returned", preview.summary.returnedRows],
                ["Cancelled by client", preview.summary.cancelledRows],
                ["Duplicates", preview.summary.duplicates],
                ["Invalid", preview.summary.invalidRows],
                ["Product mappings", unresolvedProducts],
                ["Wilaya mappings", unresolvedWilayas],
                [
                  "Automatic 150 DA charges",
                  money(preview.summary.automaticFeeAmount),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </Panel>

          {manualProductMappings.length > 0 && (
            <Panel
              title="Product mapping"
              subtitle="Only descriptions without a confident automatic match appear here. Map each to one or more existing catalog items."
            >
              <div className="mapping-list">
                {manualProductMappings.map((mapping) => (
                  <div className="mapping-card" key={mapping.key}>
                    <div className="mapping-source">
                      <span>Excel value</span>
                      <strong>{mapping.originalValue}</strong>
                      {!(productMappings[mapping.key] || []).length && (
                        <Badge tone="failed_delivery">Needs mapping</Badge>
                      )}
                    </div>
                    <div className="mapping-targets">
                      {(productMappings[mapping.key] || []).map(
                        (item, index) => (
                          <div
                            className="mapping-row"
                            key={`${mapping.key}-${index}`}
                          >
                            <select
                              aria-label={`Catalog item for ${mapping.originalValue}`}
                              value={item.catalogItemId}
                              onChange={(event) => {
                                const option = catalogById.get(
                                  event.target.value,
                                );
                                updateProductItem(mapping.key, index, {
                                  catalogItemId: event.target.value,
                                  business: option.business,
                                });
                              }}
                            >
                              {preview.catalogOptions.map((option) => (
                                <option key={option._id} value={option._id}>
                                  {option.business} · {option.name}
                                </option>
                              ))}
                            </select>
                            <label>
                              Qty
                              <input
                                type="number"
                                min="1"
                                max="10000"
                                value={item.quantity}
                                onChange={(event) =>
                                  updateProductItem(mapping.key, index, {
                                    quantity: Number(event.target.value),
                                  })
                                }
                              />
                            </label>
                            <button
                              className="icon-button"
                              title="Remove mapped item"
                              onClick={() =>
                                removeProductItem(mapping.key, index)
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ),
                      )}
                      <button
                        disabled={!preview.catalogOptions.length}
                        onClick={() => addProductItem(mapping.key)}
                      >
                        <Plus size={15} /> Add catalog item
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {manualWilayaMappings.length > 0 && (
            <Panel
              title="Wilaya mapping"
              subtitle="Only unmatched names appear here. Link them to an existing active CRM Wilaya; no Wilaya records are created."
            >
              <div className="wilaya-mapping-grid">
                {manualWilayaMappings.map((mapping) => (
                  <label key={mapping.key}>
                    <span>{mapping.originalValue}</span>
                    <select
                      value={wilayaMappings[mapping.key] || ""}
                      onChange={(event) =>
                        setWilayaMappings((current) => ({
                          ...current,
                          [mapping.key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Needs mapping</option>
                      {preview.wilayaOptions.map((wilaya) => (
                        <option key={wilaya._id} value={wilaya._id}>
                          {wilaya.agencyId} · {wilaya.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </Panel>
          )}

          <Panel
            title="Review rows"
            subtitle="Unknown statuses remain visible and use the safe CONFIRMED fallback. Clear a checkbox to exclude any row."
            action={<Badge>{selectedCount} selected</Badge>}
          >
            <div className="import-selection-toolbar">
              <div className="import-actions">
                <button onClick={selectAllImportable}>
                  Select all importable
                </button>
                <button onClick={() => setSelected(new Set())}>
                  Deselect all
                </button>
              </div>
              <span>
                {selectedCount} selected · {selectedReady} ready to import ·{" "}
                {selectedNeedResolution} need resolution
              </span>
            </div>
            <DataTable
              rowKey="rowNumber"
              rows={preview.rows}
              columns={[
                { key: "tracking", label: "Tracking" },
                { key: "client", label: "Client" },
                { key: "phone", label: "Phone" },
                { key: "wilaya", label: "Wilaya" },
                { key: "commune", label: "Commune" },
                { key: "product", label: "Product" },
                {
                  key: "situation",
                  label: "Situation",
                  render: (row) => (
                    <span className={row.unknownStatus ? "warning-text" : ""}>
                      {row.situation}
                      {row.unknownStatus && <AlertTriangle size={13} />}
                    </span>
                  ),
                },
                { key: "mappedStatus", label: "Mapped CRM status" },
                {
                  key: "total",
                  label: "Total",
                  render: (row) => (row.total == null ? "—" : money(row.total)),
                },
                {
                  key: "deliveryFee",
                  label: "Delivery fee",
                  render: (row) => money(row.deliveryFee),
                },
                {
                  key: "action",
                  label: "Action",
                  render: (row) => {
                    const ready = rowReady(row);
                    const selectable = rowSelectable(row);
                    return (
                      <label className="row-select">
                        <input
                          type="checkbox"
                          disabled={!selectable}
                          checked={selected.has(row.rowNumber)}
                          onChange={() => toggleRow(row.rowNumber)}
                        />
                        {actionLabel(row, ready)}
                      </label>
                    );
                  },
                },
                {
                  key: "validationResult",
                  label: "Validation result",
                  render: (row) =>
                    rowReady(row) ? (
                      <span className="success-text">Ready</span>
                    ) : (
                      row.validationResult
                    ),
                },
              ]}
            />
            <div className="import-actions import-commit">
              <div>
                <strong>
                  {selectedCount} selected · {selectedReady} ready ·{" "}
                  {selectedNeedResolution} need resolution
                </strong>
                {selectedNeedResolution > 0 && (
                  <span className="warning-text import-resolution-warning">
                    Resolve or deselect the remaining rows before importing.
                  </span>
                )}
              </div>
              {can(user, P.imports.execute) ? (
                <button
                  className="primary"
                  disabled={
                    busy || !selectedReady || selectedNeedResolution > 0
                  }
                  onClick={commit}
                >
                  {busy
                    ? "Importing…"
                    : `Import ${selectedReady} ready row${selectedReady === 1 ? "" : "s"}`}
                </button>
              ) : (
                <Badge tone="failed_delivery">imports.execute required</Badge>
              )}
            </div>
          </Panel>
        </>
      )}

      {result && (
        <Panel
          className="import-result"
          title="Import completed"
          subtitle={`Batch ${result.batchId}`}
          action={<Check size={22} />}
        >
          <div className="import-summary">
            {[
              ["Imported", result.imported],
              ["Updated existing", result.updatedExisting],
              ["Returned", result.returned],
              ["Cancelled by client", result.cancelled],
              ["150 DA fees created", result.feesCreated],
              ["Total fees", money(result.totalFees)],
              ["Delivered ignored", result.deliveredIgnored],
              ["Duplicates skipped", result.duplicatesSkipped],
              ["Invalid skipped", result.invalidSkipped],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {result.failures.length > 0 && (
            <div className="import-failures">
              <h3>Per-row failures</h3>
              <ul>
                {result.failures.map((failure) => (
                  <li key={`${failure.rowNumber}-${failure.tracking}`}>
                    Row {failure.rowNumber}
                    {failure.tracking ? ` · ${failure.tracking}` : ""}:{" "}
                    {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title="Import history"
        subtitle="Completed batches visible within your assigned businesses."
      >
        <ErrorBox error={history.error} />
        <DataTable
          rows={history.data || []}
          columns={[
            { key: "filename", label: "File" },
            {
              key: "createdAt",
              label: "Imported",
              render: (row) => new Date(row.createdAt).toLocaleString(),
            },
            {
              key: "businesses",
              label: "Businesses",
              render: (row) => row.businesses.join(" + ") || "—",
            },
            { key: "totalRows", label: "Rows" },
            { key: "importedRows", label: "Imported" },
            { key: "updatedRows", label: "Updated" },
            { key: "feesCreated", label: "Fees" },
            {
              key: "feeAmount",
              label: "Fee amount",
              render: (row) => money(row.feeAmount),
            },
            {
              key: "status",
              label: "Status",
              render: (row) => <Badge>{row.status}</Badge>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
