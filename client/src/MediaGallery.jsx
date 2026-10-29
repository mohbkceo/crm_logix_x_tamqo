import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ErrorBox, Field } from "./components";
const emptyImages = [];

export function OptionalImagePreview({ file }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img src={url} alt={file.name} /> : null;
}

// Same authenticated URLs, Field/ErrorBox components and image-strip styling as
// the order form. A failed media request never re-submits the order or report.
export function MediaGallery({
  endpoint,
  images = emptyImages,
  revision,
  editable = false,
  disabled = false,
  onChange,
}) {
  const [current, setCurrent] = useState({ images, revision });
  const [selection, setSelection] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setCurrent((value) =>
      revision >= value.revision ? { images, revision } : value,
    );
  }, [images, revision]);
  function choose(file, id = null) {
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError("Select a JPEG, PNG or WebP image, 5 MB or smaller.");
      return;
    }
    setError("");
    setSelection({ file, id });
  }
  async function save(method, id, file) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let body = { expectedRevision: current.revision };
      if (file) {
        body = new FormData();
        body.append("image", file);
        body.append("expectedRevision", current.revision);
      }
      const saved = await api(endpoint + (id ? "/" + id : ""), {
        method,
        body,
      });
      setCurrent(saved);
      setSelection(null);
      onChange?.(saved);
    } catch (e) {
      setError(e.message);
      // Refresh a stale revision without discarding the selected file for retry.
      try {
        setCurrent(await api(endpoint));
      } catch {
        /* Keep the original error. */
      }
      onChange?.();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const locked = busy || disabled;
  return (
    <div aria-busy={busy}>
      <ErrorBox error={error} />
      <div className="tracking-image-strip">
        {current.images.map((image, index) => {
          const url = image.url || `/api${endpoint}/${image._id}`;
          return (
            <div key={image._id} style={{ maxWidth: "100%", minWidth: 0 }}>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <img
                  src={url + "?thumbnail=true"}
                  alt={`Reference image ${index + 1}`}
                  loading="lazy"
                />
              </a>
              {editable && (
                <>
                  <Field label={`Replace image ${index + 1}`}>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={locked}
                      onChange={(e) => {
                        choose(e.target.files?.[0], image._id);
                        e.target.value = "";
                      }}
                    />
                  </Field>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => save("DELETE", image._id)}
                  >
                    Remove image {index + 1}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {editable && current.images.length < 6 && (
        <Field
          label="Add image"
          hint="JPEG, PNG or WebP, up to 5 MB. Maximum six images."
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={locked}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </Field>
      )}
      {editable && selection && (
        <>
          <div className="tracking-image-strip">
            <OptionalImagePreview file={selection.file} />
          </div>
          <button
            type="button"
            className="primary"
            disabled={locked}
            onClick={() =>
              save(selection.id ? "PUT" : "POST", selection.id, selection.file)
            }
          >
            {busy
              ? "Uploading…"
              : selection.id
                ? "Replace image"
                : "Upload image"}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => setSelection(null)}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
