import CustomSelect from '../../CustomSelect'
import { Download, FileText, FileUp } from 'lucide-react'
import { SpinnerButton } from '../../SpinnerButton'
import { openStoredFile } from '../../files'
import { useAppData } from '../../context/AppDataContext'

export default function DocumentsPage() {
  const { addToast, documents, handleUploadDocument, newDocCategory, setNewDocCategory, uploadingDocument } = useAppData();

  return (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Document Archive</span>
                  <h1 className="page-title">Digital Document Repository</h1>
                  <span className="page-subtitle">Unified safehouse for invoices, warranty certificates, and SLA documents</span>
                </div>
              </div>

              <div className="dashboard-grid-secondary">
                {/* File Upload component */}
                <div className="card">
                  <span className="card-title">Upload Official Agreement / Scan</span>
                  <form onSubmit={handleUploadDocument} className="form-grid">
                    <div className="form-group">
                      <label className="form-label">File Descriptor Name</label>
                      <input type="text" name="name" placeholder="e.g. Server Warranty Certificate" className="form-input" required />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Document Category</label>
                      <CustomSelect
                        name="type"
                        options={[
                          { value: "Invoice", label: "Invoice" },
                          { value: "Warranty Certificate", label: "Warranty Certificate" },
                          { value: "AMC Agreement", label: "AMC Agreement" },
                          { value: "Vendor Contract", label: "Vendor Contract" },
                          { value: "Service Report", label: "Service Report" }
                        ]}
                        value={newDocCategory}
                        onChange={(e) => setNewDocCategory(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Attach File Scan</label>
                      <input type="file" name="file" className="form-input" required />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Map Association Reference</label>
                      <input type="text" name="association" placeholder="e.g. Asset AST-002, AMC AMC-101" className="form-input" required />
                    </div>
                    <div className="form-group full-width" style={{ marginTop: '8px' }}>
                      <SpinnerButton type="submit" className="btn btn-primary" style={{ width: '100%' }} icon={FileUp} spinnerSize={16} loading={uploadingDocument} loadingText="Uploading…">Upload Attachment Scan</SpinnerButton>
                    </div>
                  </form>
                </div>

                <div className="card">
                  <span className="card-title">Repository Vault Statistics</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span>Stored Scan Records:</span>
                      <span style={{ fontWeight: '700' }}>{documents.length} Files</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span>System Storage Capacity:</span>
                      <span style={{ fontWeight: '700', color: 'var(--status-available)' }}>99.9% Available</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Documents Card Grid */}
              <div className="doc-grid" style={{ marginTop: '16px' }}>
                {documents.map(doc => (
                  <div key={doc.id} className="doc-card" onClick={() => {
                    if (doc.fileUrl) {
                      openStoredFile(doc.fileUrl, (msg) => addToast("Cannot open document", msg, "error"));
                      addToast("Opening Document", `Displaying file: ${doc.name}`, "info");
                    } else {
                      alert(`Initiating secure mock download for: ${doc.name}`);
                      addToast("Secure Download", `File ${doc.name} download started.`, "success");
                    }
                  }}>
                    <div className="doc-type-icon">
                      <FileText size={20} />
                    </div>
                    <div className="doc-title-section">
                      <span className="doc-title" title={doc.name}>{doc.name}</span>
                      <span className="doc-meta">{doc.type}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Ref: {doc.association}</div>
                    <div className="doc-footer">
                      <span className="doc-size">{doc.size}</span>
                      <span className="doc-action">
                        <Download size={13} style={{ display: 'inline', marginRight: '4px' }} />
                        Download
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
  );
}
