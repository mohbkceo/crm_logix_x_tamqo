import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, Plus, Trash2 } from "lucide-react";
import { hasBusinessAccess, useUser } from "../access";
import { api, human, money, params, useApi, useConfig } from "../api";
import { ErrorBox, Field, Loading, Modal } from "../components";
import { OptionalImagePreview } from "../MediaGallery";
import { findAbexCommune } from "../../../shared/abexTerritories.js";

const businesses = ["TAMQO", "LOGIX"];
const currentRequest = { keepPreviousData: false };
const imageTypes = ["image/jpeg", "image/png", "image/webp"];

function initialForm(original, config) {
  const defaultSource =
    config.sources.find((source) => source.active && source.isDefault)?._id ||
    "";
  if (original)
    return {
      ...original,
      customer: {
        ...original.customer,
        name: original.customer?.name ?? "",
        phoneA: original.customer?.phoneA ?? "",
      },
      location: {
        ...original.location,
        wilayaId: original.location?.wilayaId ?? "",
        commune: original.location?.commune ?? "",
        address: original.location?.address ?? "",
      },
      sourceId: original.source?.id || defaultSource,
      deliveryCharged: null,
      items: original.items.map((item, index) => ({ ...item, _key: index })),
    };
  return {
    customer: { name: "", phoneA: "", phoneB: "" },
    location: { wilayaId: "", commune: "", address: "" },
    note: "",
    sourceId: defaultSource,
    items: [],
    delivery: { type: "HOME", exchange: false },
    deliveryCharged: null,
    payment: { method: "COD", amountPaidOnline: "" },
  };
}

function validPhone(value) {
  const digits = value
    .replace(/[\s().-]/g, "")
    .replace(/^(?:00(?=213)|\+)/, "");
  return value.length <= 30 && /^(?:0|213)[5-7]\d{8}$/.test(digits);
}

function validAmount(value) {
  const amount = Number(value);
  return (
    value !== "" &&
    amount >= 0 &&
    amount <= 1e10 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 0.0001
  );
}

function OrderSection({ title, children }) {
  return (
    <section className="order-entry-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Disclosure({ label, initiallyOpen, children }) {
  const initialOpen = useRef(initiallyOpen).current;
  return (
    <details className="order-disclosure" open={initialOpen || undefined}>
      <summary>
        <ChevronDown size={16} aria-hidden="true" />
        {label}
      </summary>
      <div className="order-disclosure-fields">{children}</div>
    </details>
  );
}

function Retry({ children, onRetry }) {
  return (
    <div className="order-lookup-message">
      <span role="status">{children}</span>
      <button type="button" className="text-link" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    function update() {
      setOpen(
        viewport.scale === 1 && window.innerHeight - viewport.height > 120,
      );
    }
    viewport.addEventListener("resize", update);
    update();
    return () => viewport.removeEventListener("resize", update);
  }, []);
  return open;
}

function handleEntryKey(event) {
  const input = event.target;
  if (
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    !["text", "tel", "number"].includes(input.type)
  )
    return;
  event.preventDefault();
  if (input.enterKeyHint === "next") {
    const fields = [
      ...input
        .closest("section")
        .querySelectorAll(
          'input:is([type="tel"], [type="number"], :not([type]))',
        ),
    ];
    const next = fields
      .slice(fields.indexOf(input) + 1)
      .find(
        (field) =>
          !field.readOnly &&
          !field.disabled &&
          !field.closest("details:not([open])"),
      );
    if (next) {
      next.focus();
      return;
    }
  }
  input.blur();
}

export function OrderForm() {
  const { id } = useParams();
  const order = useApi(id ? "/orders/" + id : null, currentRequest);
  if (id && !order.data)
    return order.error ? (
      <Retry onRetry={order.reload}>{order.error}</Retry>
    ) : (
      <Loading />
    );
  return <OrderEditor key={id || "new"} original={id ? order.data : null} />;
}

function OrderEditor({ original }) {
  const user = useUser();
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const [form, setForm] = useState(() => initialForm(original, config));
  const [communeWilaya, setCommuneWilaya] = useState(form.location.wilayaId);
  const [keepSavedRate, setKeepSavedRate] = useState(Boolean(original));
  const [optionalImages, setOptionalImages] = useState([]);
  const [imageError, setImageError] = useState("");
  const [itemError, setItemError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editDialog, setEditDialog] = useState(false);
  const [providerConfirmed, setProviderConfirmed] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const saving = useRef(false);
  const nextItemKey = useRef(form.items.length);
  const formRef = useRef(null);
  const summaryRef = useRef(null);
  const saveErrorRef = useRef(null);
  const id = original?._id;
  const agencies = useApi("/delivery-agencies");
  const eligible = (agencies.data || []).filter(
    (agency) =>
      (agency.active || agency._id === form.delivery.agencyId) &&
      form.items.length > 0 &&
      form.items.every((item) => agency.businesses.includes(item.business)),
  );
  const agency = eligible.find(
    (candidate) => candidate._id === form.delivery.agencyId,
  );
  const { customer, location, delivery, payment, items } = form;
  const rates = useApi(
    agency && location.wilayaId
      ? "/delivery-agencies/" + agency._id + "/rates"
      : null,
    currentRequest,
  );
  const rate = rates.data?.find(
    (row) => row.wilayaId === location.wilayaId && row.active,
  );
  const agencyPrice =
    delivery.type === "HOME" ? rate?.homePrice : rate?.deskPrice;
  const savedRate =
    keepSavedRate &&
    original.delivery.agencyId === delivery.agencyId &&
    original.location?.wilayaId === location.wilayaId &&
    original.delivery.type === delivery.type
      ? original.deliveryCharged
      : null;
  const deliveryCost = form.deliveryCharged ?? savedRate ?? agencyPrice ?? "";
  const communePath =
    agency?.apiProvider === "ABEX" && location.wilayaId
      ? `/delivery-agencies/${agency._id}/communes?${params({
          wilayaId: location.wilayaId,
          deliveryType: delivery.type,
        })}`
      : null;
  const communeCatalog = useApi(communePath, currentRequest);
  const communes = communeCatalog.data?.communes ?? [];
  const communeMatchesWilaya =
    !communeWilaya || communeWilaya === location.wilayaId;
  const communeValue = communeMatchesWilaya ? location.commune : "";
  const selectedCommune = findAbexCommune(communes, communeValue);
  const communeLoading = Boolean(communePath && communeCatalog.loading);
  const catalog = (business) =>
    business === "TAMQO" ? config.plans : config.products;
  const subtotals = Object.fromEntries(
    businesses.map((business) => [
      business,
      items.reduce(
        (total, item) =>
          item.business === business
            ? total + item.unitPrice * item.quantity
            : total,
        0,
      ),
    ]),
  );
  const total =
    Math.round(
      (subtotals.TAMQO + subtotals.LOGIX + Number(deliveryCost)) * 100,
    ) / 100;
  const paid =
    payment.method === "ONLINE"
      ? total
      : payment.method === "COD"
        ? 0
        : Number(payment.amountPaidOnline);
  const balance = Math.round((total - paid) * 100) / 100;
  const totalLabel =
    deliveryCost === "" && items.length ? "Total so far" : "Total";
  const imageSlots = 6 - (original?.images?.length || 0);

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateRoute(key, value) {
    setForm((current) => ({
      ...current,
      ...(key === "wilayaId"
        ? { location: { ...current.location, wilayaId: value } }
        : { delivery: { ...current.delivery, [key]: value } }),
    }));
  }

  function setCommune(value) {
    setCommuneWilaya(location.wilayaId);
    set("location", { ...location, commune: value });
  }

  function addItem(business) {
    const product = catalog(business).find((entry) => entry.active);
    if (!product) {
      setItemError(
        `Add an active ${business === "TAMQO" ? "plan" : "product"} in Settings first.`,
      );
      return;
    }
    if (items.length >= 50) {
      setItemError("An order can have up to 50 items.");
      return;
    }
    setItemError("");
    const item = {
      _key: nextItemKey.current++,
      business,
      catalogItemId: product._id,
      unitPrice: product.price,
      quantity: 1,
      isRenewal: false,
    };
    setForm((current) => ({ ...current, items: [...current.items, item] }));
  }

  function editItem(key, values) {
    setForm((current) => ({
      ...current,
      items: current.items.map((item) =>
        item._key === key ? { ...item, ...values } : item,
      ),
    }));
  }

  function removeItems(predicate) {
    setItemError("");
    setForm((current) => ({
      ...current,
      items: current.items.filter((item) => !predicate(item)),
    }));
  }

  function validate() {
    const errors = {};
    if (customer.name.trim().length < 2)
      errors.customerName = "Enter the customer's full name.";
    if (!customer.phoneA.trim())
      errors.phoneA = "Enter the customer's phone number.";
    else if (!validPhone(customer.phoneA))
      errors.phoneA =
        "Enter an Algerian mobile number starting with 05, 06 or 07.";
    if (customer.phoneB && !validPhone(customer.phoneB))
      errors.phoneB = "Enter a valid second phone number.";
    if (!items.length) errors.items = "Select a business to add an item.";
    for (const business of businesses) {
      for (const item of items.filter((entry) => entry.business === business)) {
        if (
          !catalog(business).some((entry) => entry._id === item.catalogItemId)
        )
          errors[`product-${item._key}`] = "Select a product or plan.";
        if (
          !Number.isInteger(Number(item.quantity)) ||
          item.quantity < 1 ||
          item.quantity > 10000
        )
          errors[`quantity-${item._key}`] =
            "Enter a whole quantity from 1 to 10,000.";
        if (!validAmount(item.unitPrice))
          errors[`price-${item._key}`] =
            "Enter a unit price with up to two decimals.";
      }
    }
    if (!form.sourceId) errors.sourceId = "Select an order source.";
    if (!agency)
      errors.agencyId = agencies.loading
        ? "Wait for delivery agencies to load."
        : "Select a delivery agency that serves every item.";
    if (!location.wilayaId) errors.wilayaId = "Select a Wilaya.";
    if (communeLoading) errors.commune = "Wait for ABEX communes to load.";
    else if (communes.length && !selectedCommune)
      errors.commune = "Select a commune for this Wilaya.";
    else if (!communeValue.trim())
      errors.commune = "Enter the delivery commune.";
    if (location.address.trim().length < 3)
      errors.address = "Enter the delivery address.";
    if (!validAmount(deliveryCost))
      errors.deliveryCost =
        deliveryCost === "" && rates.loading
          ? "Wait for the rate or enter a delivery cost."
          : "Enter a delivery cost with up to two decimals.";
    if (total > 1e10)
      errors.deliveryCost = "The order total exceeds the supported amount.";
    if (
      payment.method === "MIXED" &&
      (!validAmount(payment.amountPaidOnline) || paid <= 0 || paid >= total)
    )
      errors.amountPaid =
        "Enter an amount greater than zero and less than the order total.";
    return errors;
  }

  const errors = attempted ? validate() : {};
  const invalidFields = Object.entries(errors);

  function focusField(name) {
    const field = formRef.current?.querySelector(`[name="${name}"]`);
    const details = field?.closest("details");
    if (details) details.open = true;
    if (field?.disabled) {
      field.closest(".field")?.scrollIntoView({ block: "center" });
    } else {
      field?.focus({ preventScroll: true });
      field?.scrollIntoView({ block: "center" });
    }
  }

  function chooseImages(event) {
    const files = Array.from(event.target.files);
    event.target.value = "";
    if (!files.length) return;
    if (
      files.length > imageSlots ||
      files.some(
        (file) =>
          !imageTypes.includes(file.type) || file.size > 5 * 1024 * 1024,
      )
    ) {
      setImageError(
        `Select up to ${imageSlots} JPEG, PNG or WebP images, 5 MB each.`,
      );
      return;
    }
    setImageError("");
    setOptionalImages(files);
  }

  function courierFields(value, current = false) {
    return JSON.stringify({
      customer: [
        value.customer?.name,
        value.customer?.phoneA,
        value.customer?.phoneB || "",
      ],
      location: [
        current
          ? config.wilayas.find(
              (wilaya) => wilaya._id === value.location.wilayaId,
            )?.agencyId || value.location.agencyId
          : value.location?.agencyId,
        value.location?.commune,
        value.location?.address,
      ],
      source: current
        ? config.sources.find((source) => source._id === value.sourceId)
            ?.name || value.source?.name
        : value.source?.name,
      note: value.note || "",
      delivery: [value.delivery.type, Boolean(value.delivery.exchange)],
      collect: current ? balance : value.payment.amountToCollect,
      products: value.items.map((item) => [
        current
          ? [...config.plans, ...config.products].find(
              (entry) => entry._id === item.catalogItemId,
            )?.name || item.name
          : item.name,
        current ? Number(item.quantity) : item.quantity,
      ]),
    });
  }

  const agencyChange = Boolean(
    original?.shipment && original.delivery.agencyId !== delivery.agencyId,
  );
  const manualProviderStep = agencyChange
    ? !original?.deliveryAgency?.capabilities?.deleteShipment ||
      original?.deliveryAgency?.integrationType === "MANUAL"
    : original?.deliveryAgency?.integrationType === "API" &&
      !original?.deliveryAgency?.capabilities?.updateShipment;

  async function save(confirmation) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setSaveError("");
    try {
      const order = await api(id ? `/orders/${id}` : "/orders", {
        method: id ? "PATCH" : "POST",
        body: {
          ...form,
          ...confirmation,
          items: items.map(({ _key, ...item }) => ({
            ...item,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
          })),
          deliveryCharged: Number(deliveryCost),
          payment: { method: payment.method, amountPaidOnline: paid },
        },
      });
      let imageWarning = "";
      let imageRevision = order.revision;
      for (const image of optionalImages) {
        try {
          const upload = new FormData();
          upload.append("image", image);
          upload.append("expectedRevision", imageRevision);
          const saved = await api(`/order-media/${order._id}`, {
            method: "POST",
            body: upload,
          });
          imageRevision = saved.revision;
        } catch (error) {
          imageWarning = `Order saved. Optional image upload failed: ${error.message} You can attach it from Edit order.`;
          break;
        }
      }
      navigate("/orders/" + order._id, {
        state: { shipmentSync: order.shipmentSync, imageWarning },
      });
    } catch (error) {
      setSaveError(error.message);
      requestAnimationFrame(() => saveErrorRef.current?.focus());
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (saving.current) return;
    setAttempted(true);
    setSaveError("");
    const [firstError] = Object.keys(validate());
    if (firstError) {
      requestAnimationFrame(() => focusField(firstError));
      return;
    }
    if (
      original?.shipment &&
      (agencyChange ||
        (original.deliveryAgency?.integrationType === "API" &&
          (original.shipment.tracking ||
            original.shipment.creationAttemptedAt ||
            original.shipment.providerAccepted ||
            original.shipment.providerParcelId) &&
          courierFields(original) !== courierFields(form, true)))
    ) {
      setProviderConfirmed(false);
      setEditDialog(true);
      return;
    }
    save();
  }

  function toggleSummary() {
    setSummaryOpen(!summaryOpen);
    if (!summaryOpen)
      requestAnimationFrame(() =>
        summaryRef.current?.scrollIntoView({ block: "end" }),
      );
  }

  return (
    <div className="order-entry">
      <Link className="back-link" to={id ? `/orders/${id}` : "/orders"}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to {id ? "order" : "orders"}
      </Link>
      <h1>{id ? "Edit order" : "Create an order"}</h1>
      <form
        ref={formRef}
        className="order-entry-form"
        noValidate
        onSubmit={submit}
        onKeyDown={handleEntryKey}
        data-keyboard-open={keyboardOpen}
      >
        <fieldset disabled={busy} className="order-entry-fields">
          {invalidFields.length > 0 && (
            <div className="order-validation" role="alert">
              <strong>Check these fields before saving</strong>
              <ul>
                {invalidFields.map(([name, message]) => (
                  <li key={name}>
                    <button
                      className="text-link"
                      type="button"
                      onClick={() => focusField(name)}
                    >
                      {message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <OrderSection title="Customer">
            <Field label="Customer name *" error={errors.customerName}>
              <input
                name="customerName"
                required
                maxLength={150}
                autoComplete="name"
                enterKeyHint="next"
                value={customer.name}
                onChange={(event) =>
                  set("customer", { ...customer, name: event.target.value })
                }
              />
            </Field>
            <Field label="Primary phone *" error={errors.phoneA}>
              <input
                name="phoneA"
                required
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                enterKeyHint="next"
                dir="ltr"
                maxLength={30}
                value={customer.phoneA}
                onChange={(event) =>
                  set("customer", { ...customer, phoneA: event.target.value })
                }
              />
            </Field>
            <Disclosure
              label="Second phone (optional)"
              initiallyOpen={Boolean(original?.customer?.phoneB)}
            >
              <Field label="Second phone number" error={errors.phoneB}>
                <input
                  name="phoneB"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  enterKeyHint="next"
                  dir="ltr"
                  maxLength={30}
                  value={customer.phoneB || ""}
                  onChange={(event) =>
                    set("customer", { ...customer, phoneB: event.target.value })
                  }
                />
              </Field>
            </Disclosure>
          </OrderSection>

          <OrderSection title="Products">
            <fieldset
              className="order-business"
              aria-describedby={
                errors.items ? "order-business-error" : undefined
              }
            >
              <legend>Business *</legend>
              <div className="order-business-options">
                {businesses
                  .filter((business) => hasBusinessAccess(user, business))
                  .map((business) => (
                    <label key={business}>
                      <input
                        name="items"
                        type="checkbox"
                        checked={items.some(
                          (item) => item.business === business,
                        )}
                        onChange={(event) =>
                          event.target.checked
                            ? addItem(business)
                            : removeItems((item) => item.business === business)
                        }
                      />
                      {human(business)}
                    </label>
                  ))}
              </div>
              {errors.items && (
                <small className="field-error" id="order-business-error">
                  {errors.items}
                </small>
              )}
              <ErrorBox error={itemError} />
            </fieldset>
            {businesses.map((business) => {
              const lines = items.filter((item) => item.business === business);
              if (!lines.length) return null;
              return (
                <div className="order-item-group" key={business}>
                  {lines.map((item, index) => (
                    <div className="order-item" key={item._key}>
                      <Field
                        label={business === "TAMQO" ? "Plan *" : "Product *"}
                        error={errors[`product-${item._key}`]}
                      >
                        <select
                          name={`product-${item._key}`}
                          required
                          value={item.catalogItemId}
                          onChange={(event) => {
                            const product = catalog(business).find(
                              (entry) => entry._id === event.target.value,
                            );
                            if (product)
                              editItem(item._key, {
                                catalogItemId: product._id,
                                unitPrice: product.price,
                              });
                          }}
                        >
                          {!catalog(business).some(
                            (entry) => entry._id === item.catalogItemId,
                          ) && (
                            <option value={item.catalogItemId}>
                              {item.name || "Choose an item"}
                            </option>
                          )}
                          {catalog(business)
                            .filter(
                              (entry) =>
                                entry.active ||
                                entry._id === item.catalogItemId,
                            )
                            .map((entry) => (
                              <option key={entry._id} value={entry._id}>
                                {entry.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <div className="order-item-amounts">
                        <Field
                          label="Quantity *"
                          error={errors[`quantity-${item._key}`]}
                        >
                          <input
                            name={`quantity-${item._key}`}
                            required
                            type="number"
                            min="1"
                            max="10000"
                            inputMode="numeric"
                            enterKeyHint="next"
                            dir="ltr"
                            value={item.quantity}
                            onChange={(event) =>
                              editItem(item._key, {
                                quantity: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field
                          label="Unit price (DA) *"
                          error={errors[`price-${item._key}`]}
                        >
                          <input
                            name={`price-${item._key}`}
                            required
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            enterKeyHint="next"
                            dir="ltr"
                            value={item.unitPrice}
                            onChange={(event) =>
                              editItem(item._key, {
                                unitPrice: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <div className="order-item-total">
                        <span>
                          Subtotal{" "}
                          <b dir="ltr">
                            {money(item.unitPrice * item.quantity)}
                          </b>
                        </span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${human(business)} item ${index + 1}`}
                          onClick={() =>
                            removeItems((entry) => entry._key === item._key)
                          }
                        >
                          <Trash2 size={17} aria-hidden="true" />
                        </button>
                      </div>
                      {business === "LOGIX" ? (
                        <Disclosure
                          label="Specifications (optional)"
                          initiallyOpen={Boolean(item.specifications)}
                        >
                          <Field label="Specifications">
                            <input
                              maxLength={1000}
                              value={item.specifications || ""}
                              onChange={(event) =>
                                editItem(item._key, {
                                  specifications: event.target.value,
                                })
                              }
                            />
                          </Field>
                        </Disclosure>
                      ) : (
                        <label className="order-check">
                          <input
                            type="checkbox"
                            checked={Boolean(item.isRenewal)}
                            onChange={(event) =>
                              editItem(item._key, {
                                isRenewal: event.target.checked,
                              })
                            }
                          />
                          Subscription renewal
                        </label>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="order-add"
                    onClick={() => addItem(business)}
                  >
                    <Plus size={16} aria-hidden="true" /> Add {human(business)}{" "}
                    item
                  </button>
                </div>
              );
            })}
            <Field label="Order source *" error={errors.sourceId}>
              <select
                name="sourceId"
                required
                value={form.sourceId}
                onChange={(event) => set("sourceId", event.target.value)}
              >
                <option value="">Choose source</option>
                {config.sources
                  .filter(
                    (source) => source.active || source._id === form.sourceId,
                  )
                  .map((source) => (
                    <option key={source._id} value={source._id}>
                      {source.name}
                    </option>
                  ))}
              </select>
            </Field>
          </OrderSection>

          <OrderSection title="Delivery">
            <Field
              label="Delivery agency *"
              error={errors.agencyId}
              hint={
                items.length &&
                !agencies.loading &&
                !agencies.error &&
                !eligible.length
                  ? "No agency serves all the selected businesses."
                  : undefined
              }
            >
              <select
                name="agencyId"
                required
                value={agency?._id || ""}
                onChange={(event) =>
                  updateRoute("agencyId", event.target.value)
                }
              >
                <option value="">
                  {agencies.loading
                    ? "Loading agencies…"
                    : items.length
                      ? "Choose agency"
                      : "Add an item first"}
                </option>
                {eligible.map((option) => (
                  <option key={option._id} value={option._id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </Field>
            {agencies.error && (
              <Retry onRetry={agencies.reload}>
                Couldn’t load delivery agencies.
              </Retry>
            )}
            <Field label="Wilaya *" error={errors.wilayaId}>
              <select
                name="wilayaId"
                required
                value={location.wilayaId}
                onChange={(event) =>
                  updateRoute("wilayaId", event.target.value)
                }
              >
                <option value="">Choose a Wilaya</option>
                {config.wilayas
                  .filter(
                    (wilaya) =>
                      wilaya.active || wilaya._id === location.wilayaId,
                  )
                  .map((wilaya) => (
                    <option key={wilaya._id} value={wilaya._id}>
                      {wilaya.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Delivery type">
              <select
                value={delivery.type}
                onChange={(event) => updateRoute("type", event.target.value)}
              >
                <option value="HOME">Home</option>
                <option value="STOP_DESK">Stop desk</option>
              </select>
            </Field>
            <Field
              label="Commune *"
              error={errors.commune}
              hint={
                location.commune &&
                (!communeMatchesWilaya ||
                  (communes.length > 0 && !selectedCommune))
                  ? `Previous commune: ${location.commune}`
                  : undefined
              }
            >
              {communes.length ? (
                <select
                  name="commune"
                  required
                  value={selectedCommune?.name || ""}
                  onChange={(event) => setCommune(event.target.value)}
                >
                  <option value="">Choose a commune</option>
                  {communes.map(({ name }) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name="commune"
                  required
                  maxLength={150}
                  value={communeValue}
                  readOnly={communeLoading}
                  aria-busy={communeLoading}
                  placeholder={communeLoading ? "Loading communes…" : undefined}
                  enterKeyHint="next"
                  onChange={(event) => setCommune(event.target.value)}
                />
              )}
            </Field>
            {communeLoading && (
              <small role="status" className="order-muted">
                Loading ABEX communes…
              </small>
            )}
            {communePath && !communeLoading && !communes.length && (
              <Retry onRetry={communeCatalog.reload}>
                {communeCatalog.error
                  ? "ABEX commune lookup is unavailable."
                  : "ABEX returned no communes for this route."}{" "}
                You can enter the commune manually.
              </Retry>
            )}
            <Field label="Address *" error={errors.address}>
              <input
                name="address"
                required
                autoComplete="street-address"
                enterKeyHint="next"
                maxLength={500}
                value={location.address}
                onChange={(event) =>
                  set("location", { ...location, address: event.target.value })
                }
              />
            </Field>
            <Field
              label="Delivery cost (DA) *"
              error={errors.deliveryCost}
              hint={
                agencyPrice !== undefined
                  ? `Agency rate: ${money(agencyPrice)}`
                  : rates.loading
                    ? "Loading agency rate…"
                    : rates.data
                      ? "No agency rate for this route."
                      : undefined
              }
            >
              <input
                name="deliveryCost"
                required
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                enterKeyHint="next"
                dir="ltr"
                value={deliveryCost}
                onChange={(event) => set("deliveryCharged", event.target.value)}
              />
            </Field>
            {rates.error && (
              <Retry onRetry={rates.reload}>
                Couldn’t load the agency rate. You can enter the cost manually.
              </Retry>
            )}
            {(form.deliveryCharged !== null || savedRate !== null) &&
              agencyPrice !== undefined &&
              (deliveryCost === "" || Number(deliveryCost) !== agencyPrice) && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setKeepSavedRate(false);
                    set("deliveryCharged", null);
                  }}
                >
                  Use agency rate
                </button>
              )}
            <label className="order-check">
              <input
                type="checkbox"
                checked={Boolean(delivery.exchange)}
                onChange={(event) =>
                  set("delivery", {
                    ...delivery,
                    exchange: event.target.checked,
                  })
                }
              />
              Exchange shipment
            </label>
            {agency && !id && (
              <p className="order-muted">
                {agency.integrationType === "API" &&
                agency.capabilities?.createShipment
                  ? "Saving this order automatically creates a courier parcel. Tracking or synchronization details will appear on the order."
                  : "Save this order, then handle its shipment manually."}
              </p>
            )}
          </OrderSection>

          <OrderSection title="Payment">
            <Field label="Payment method">
              <select
                value={payment.method}
                onChange={(event) =>
                  set("payment", { ...payment, method: event.target.value })
                }
              >
                <option value="COD">Cash on delivery (COD)</option>
                <option value="ONLINE">Online · fully prepaid</option>
                <option value="MIXED">Mixed · partially prepaid</option>
              </select>
            </Field>
            {payment.method === "MIXED" && (
              <Field
                label="Amount paid online (DA) *"
                error={errors.amountPaid}
              >
                <input
                  name="amountPaid"
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  enterKeyHint="done"
                  dir="ltr"
                  value={payment.amountPaidOnline}
                  onChange={(event) =>
                    set("payment", {
                      ...payment,
                      amountPaidOnline: event.target.value,
                    })
                  }
                />
              </Field>
            )}
            <dl className="order-payment-totals">
              <div>
                <dt>{totalLabel}</dt>
                <dd dir="ltr">{money(total)}</dd>
              </div>
              <div>
                <dt>Paid online</dt>
                <dd dir="ltr">{money(paid)}</dd>
              </div>
              <div>
                <dt>Courier to collect</dt>
                <dd dir="ltr">{money(balance)}</dd>
              </div>
            </dl>
            <Disclosure
              label="Order note (optional)"
              initiallyOpen={Boolean(original?.note)}
            >
              <Field label="Order note">
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={form.note || ""}
                  onChange={(event) => set("note", event.target.value)}
                />
              </Field>
            </Disclosure>
            <Disclosure
              label="Reference images (optional)"
              initiallyOpen={Boolean(original?.images?.length)}
            >
              {imageSlots > 0 && (
                <Field
                  label="Order images"
                  hint={`Up to ${imageSlots} JPEG, PNG or WebP images, 5 MB each. Images upload after the order is saved.`}
                  error={imageError}
                >
                  <input
                    type="file"
                    multiple={imageSlots > 1}
                    accept={imageTypes.join(",")}
                    onChange={chooseImages}
                  />
                </Field>
              )}
              <div className="tracking-image-strip">
                {original?.images?.map((image, index) => (
                  <img
                    key={image._id}
                    src={`/api/order-media/${id}/${image._id}`}
                    alt={`Reference image ${index + 1}`}
                  />
                ))}
                {optionalImages.map((file, index) => (
                  <OptionalImagePreview key={index} file={file} />
                ))}
              </div>
              {optionalImages.length > 0 && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setOptionalImages([]);
                    setImageError("");
                  }}
                >
                  Clear selected images
                </button>
              )}
            </Disclosure>
          </OrderSection>
        </fieldset>
        <aside
          ref={summaryRef}
          className="order-entry-summary"
          data-expanded={summaryOpen}
          data-save-error={Boolean(saveError && !editDialog)}
          aria-label="Order summary"
        >
          <div id="order-entry-breakdown" className="order-breakdown">
            <h2>Order summary</h2>
            <dl>
              {businesses
                .filter((business) =>
                  items.some((item) => item.business === business),
                )
                .map((business) => (
                  <div key={business}>
                    <dt>{human(business)}</dt>
                    <dd dir="ltr">{money(subtotals[business])}</dd>
                  </div>
                ))}
              <div>
                <dt>Delivery</dt>
                <dd dir="ltr">
                  {deliveryCost === "" ? "Pending" : money(deliveryCost)}
                </dd>
              </div>
              <div className="order-breakdown-total">
                <dt>{totalLabel}</dt>
                <dd dir="ltr">{money(total)}</dd>
              </div>
              <div>
                <dt>Paid online</dt>
                <dd dir="ltr">{money(paid)}</dd>
              </div>
              <div>
                <dt>Courier to collect</dt>
                <dd dir="ltr">{money(balance)}</dd>
              </div>
            </dl>
          </div>
          {!editDialog && saveError && (
            <div ref={saveErrorRef} tabIndex={-1} className="order-save-error">
              <ErrorBox error={saveError} />
            </div>
          )}
          <div className="order-entry-actions">
            <button
              className="order-summary-toggle"
              type="button"
              aria-controls="order-entry-breakdown"
              aria-expanded={summaryOpen}
              onClick={toggleSummary}
            >
              <span>
                <small>{totalLabel}</small>
                <b dir="ltr">{money(total)}</b>
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : id ? "Save changes" : "Create order"}
            </button>
          </div>
        </aside>
      </form>
      {editDialog && (
        <Modal
          title={
            agencyChange
              ? "Change delivery agency?"
              : "Synchronize courier parcel?"
          }
          onClose={() => {
            if (!saving.current) setEditDialog(false);
          }}
        >
          <div className="modal-body" aria-busy={busy}>
            <p>
              {agencyChange
                ? "The old parcel must be deleted or cancelled at its agency before this order can move to the new agency. A new shipment will then be created or linked."
                : "These order changes may affect the courier parcel."}
            </p>
            {manualProviderStep ? (
              <label className="checkbox-field order-check">
                <input
                  type="checkbox"
                  checked={providerConfirmed}
                  disabled={busy}
                  onChange={(event) =>
                    setProviderConfirmed(event.target.checked)
                  }
                />
                {agencyChange
                  ? original.shipment.provider === "ABEX"
                    ? "I resolved the old parcel in the ABEX portal."
                    : "I marked the old parcel Supprimée at the delivery agency."
                  : "I updated the courier parcel to match this order."}
              </label>
            ) : (
              <p>
                The delivery agency supports automatic synchronization. A
                provider error will be shown on the order.
              </p>
            )}
            {saveError && (
              <div ref={saveErrorRef} tabIndex={-1}>
                <ErrorBox error={saveError} />
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditDialog(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (manualProviderStep && !providerConfirmed)}
                onClick={() =>
                  save({
                    providerUpdateConfirmed: !agencyChange && providerConfirmed,
                    providerDeletionConfirmed:
                      agencyChange && providerConfirmed,
                  })
                }
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
