import React from 'react';
import { ExternalLink, Star } from 'lucide-react';
import { openStoredFile } from '../../files';
import { fmtDate, fmtMoney } from './requestUi';

/**
 * How a purchase request reads in the review drawer.
 *
 * The generic comparison table would render its line items and quotations as JSON blobs —
 * technically the truth, useless to someone deciding whether to approve ₹2,19,000 of laptops.
 * This is that same payload, laid out to be read. It replaces the diff table only for this
 * type; every other tab in the drawer (approvals, documents, comments, audit) is the shared
 * one, unchanged.
 */
export default function PurchaseRequestPanel({ request, addToast }) {
  const payload = request.proposedChanges || {};
  const items = payload.items || [];
  const quotations = payload.quotations || [];
  const currency = payload.currency || 'INR';

  const open = (path) => openStoredFile(path, (msg) => addToast?.('Could not open', msg, 'error'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div className="form-grid">
        <Fact label="Department" value={payload.department} />
        <Fact label="Required by" value={fmtDate(payload.requiredByDate)} />
        <Fact label="Total estimated cost" value={fmtMoney(payload.estimatedTotal, currency)} strong />
        <Fact label="Preferred vendor" value={payload.preferredVendorName || '— not chosen —'} />
      </div>

      {request.convertedTo && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: 'var(--status-available-bg)', border: '1px solid var(--status-available-glow)',
          fontSize: '13px',
        }}>
          <ExternalLink size={14} style={{ verticalAlign: '-2px', marginRight: '6px' }} />
          Converted into <strong>{request.convertedTo.label}</strong>. Open it from Finance → Purchase Orders.
        </div>
      )}

      <section>
        <Heading>Item details</Heading>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th><th>Category</th><th>Qty</th><th>Unit</th>
                <th>Est. unit cost</th><th>Est. total</th><th>Justification</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td style={{ fontWeight: 600 }}>
                    {item.description}
                    {item.notes && (
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{item.notes}</div>
                    )}
                  </td>
                  <td>{item.category || '—'}</td>
                  <td>{item.quantity}</td>
                  <td>{item.unit}</td>
                  <td>{fmtMoney(item.estimatedUnitCost, currency)}</td>
                  <td style={{ fontWeight: 600 }}>{fmtMoney(item.estimatedTotalCost, currency)}</td>
                  <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{item.justification || '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Total estimated cost</td>
                <td style={{ fontWeight: 700 }}>{fmtMoney(payload.estimatedTotal, currency)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section>
        <Heading>Vendor quotations</Heading>
        {quotations.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            No quotations were attached to this request.
          </div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr><th>Vendor</th><th>Quotation no.</th><th>Date</th><th>Amount</th><th>Document</th></tr>
              </thead>
              <tbody>
                {quotations.map((q, index) => {
                  const preferred = q.vendorId === payload.preferredVendorId;
                  return (
                    <tr key={index}>
                      <td style={{ fontWeight: 600 }}>
                        {q.vendorName || `Vendor ${q.vendorId}`}
                        {preferred && (
                          <span className="badge badge-available" style={{ marginLeft: '6px' }}>
                            <Star size={11} style={{ verticalAlign: '-1px' }} /> Preferred
                          </span>
                        )}
                      </td>
                      <td>{q.quotationNumber || '—'}</td>
                      <td>{fmtDate(q.quotationDate)}</td>
                      <td style={{ fontWeight: 600 }}>{fmtMoney(q.amount, currency)}</td>
                      <td>
                        {q.filePath ? (
                          <button className="btn btn-secondary btn-sm" onClick={() => open(q.filePath)}>
                            {q.fileName || 'View quotation'}
                          </button>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const Heading = ({ children }) => (
  <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-secondary)' }}>
    {children}
  </div>
);

const Fact = ({ label, value, strong }) => (
  <div className="form-group">
    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</div>
    <div style={{ fontSize: strong ? '15px' : '13.5px', fontWeight: strong ? 700 : 500 }}>{value || '—'}</div>
  </div>
);
