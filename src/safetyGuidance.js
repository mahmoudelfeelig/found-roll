const tenantRoutes = {
  "northport-air": "Northport Air security and controlled-property desk",
  "metro-loop": "Metro Loop transit security control",
  "grand-hall": "Grand Hall venue security office",
};

export function localSafetyGuidance(category, assignedTenant) {
  const route = tenantRoutes[assignedTenant] || "the custodian's security desk";
  const guidance = {
    suspicious_package: {
      label: "Suspicious package",
      action: "Leave it in place and follow the local emergency or security procedure.",
      retention: "Create no Found Roll record, photo, upload, or model request.",
    },
    passport: {
      label: "Passport or government ID",
      action: `Use a sealed document envelope and contact ${route}.`,
      retention: "Do not scan identity pages. Retain only a receipt ID under the tenant's documented schedule.",
    },
    payment_card: {
      label: "Payment card",
      action: `Do not record card numbers; contact ${route} and follow issuer notification procedure.`,
      retention: "Retain no PAN, expiry, CVV, or card image; keep only a coarse disposition reference.",
    },
    access_badge: {
      label: "Access badge",
      action: `Contact ${route} so access control can disable and route the badge.`,
      retention: "Do not photograph credential identifiers; retain only a coarse receipt and disposition reference.",
    },
    medication: {
      label: "Medication",
      action: `Do not identify, dispense, or relay it; contact ${route} or the onsite medical procedure.`,
      retention: "Retain no label image or patient data; follow the documented medical-property process.",
    },
  };
  return {
    ...(guidance[category] || guidance.suspicious_package),
    uploadAllowed: false,
    modelAllowed: false,
  };
}
