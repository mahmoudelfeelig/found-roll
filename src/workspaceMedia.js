import {
  caseId as fixtureCaseId,
  comparison,
  custodians,
  libraryItems,
  trayItems,
} from "./demoData.js";

function importedDateLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Imported intake";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function resolveWorkspaceMedia(demo) {
  const custodyCase = demo.authoritativeCase || {};
  const evidence = demo.intakeEvidence || null;

  if (demo.caseId === fixtureCaseId && !evidence?.src) {
    return {
      fixture: true,
      custodians,
      items: libraryItems,
      comparison,
      trayItems,
      defaultFolder: "northport|Aug 29, 2026",
      defaultSelectedItemId: "NPA_042_A",
    };
  }

  const matchingCustodian = custodians.find((item) => item.id === custodyCase.assigned_tenant) || custodians[0];
  const dateLabel = importedDateLabel(custodyCase.found_at);
  const importedItem = evidence?.src ? {
    id: evidence.id,
    custodianId: matchingCustodian.id,
    dateLabel,
    filename: evidence.filename || `${evidence.id}.jpg`,
    src: evidence.src,
    label: custodyCase.public_description || "Imported lost-property intake",
    view: custodyCase.found_zone || "Imported intake",
    dimensions: "staff-authorized display copy",
    size: evidence.displaySource === "server-derived-preview"
      ? "server-derived preview"
      : "accepted upload · local tab preview",
    imported: true,
  } : null;
  const importedCustodians = custodians.map((custodian) => ({
    ...custodian,
    folders: custodian.id === matchingCustodian.id
      ? [{ label: dateLabel, count: importedItem ? 1 : 0 }]
      : [],
  }));

  return {
    fixture: false,
    custodians: importedCustodians,
    items: importedItem ? [importedItem] : [],
    comparison: null,
    trayItems: importedItem ? [{ ...importedItem, label: "Imported preview", selected: true }] : [],
    defaultFolder: `${matchingCustodian.id}|${dateLabel}`,
    defaultSelectedItemId: importedItem?.id || "",
  };
}
