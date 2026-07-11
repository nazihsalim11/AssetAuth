/**
 * Shared Purchase Order defaults.
 *
 * DEFAULT_PO_TERMS seeds version 1 of the master Terms & Conditions the first time
 * the table is created. After that the master lives in the po_terms table and is
 * edited from Settings; this constant is never read again except as the seed.
 */

const DEFAULT_PO_TERMS = [
  '1. Prices quoted are firm and inclusive of all charges unless stated otherwise, and shall not be varied without prior written consent.',
  '2. Goods must be delivered on or before the delivery schedule specified in this Purchase Order. Time is of the essence.',
  '3. Delivery shall be made to the delivery location stated above during normal working hours, with the PO number quoted on all documents.',
  '4. All goods are subject to inspection and acceptance. Rejected goods will be returned at the supplier’s risk and expense.',
  '5. The supplier warrants that all goods are new, of merchantable quality, and free from defects in material and workmanship.',
  '6. Payment shall be made as per the payment terms stated above, against a valid tax invoice and satisfactory delivery.',
  '7. Applicable taxes must be shown separately on the invoice. The correct GST/VAT registration number must be quoted.',
  '8. The supplier shall indemnify the company against any claim arising from defective goods or breach of these terms.',
  '9. This Purchase Order may be cancelled without liability if goods are not supplied as per the agreed specification or schedule.',
  '10. This Purchase Order is governed by the laws of the jurisdiction in which the company is registered, and any dispute is subject to its courts.'
].join('\n');

module.exports = { DEFAULT_PO_TERMS };
