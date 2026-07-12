import { QrCode } from 'lucide-react'
import CustomSelect from '../../CustomSelect'
import QRCodeSticker from '../assets/QRCodeSticker'
import { useAppData } from '../../context/AppDataContext'

// QR security-sticker / scanner page. Extracted verbatim from the App() qr_lookup block;
// its state and handlers come from App via useAppData() (see AppDataContext).
export default function QrLookupPage() {
  const {
    assets,
    isScanning,
    isWebcamScanning,
    setIsWebcamScanning,
    scannerSelectedAssetId,
    setScannerSelectedAssetId,
    handleSimulateScan,
  } = useAppData();

  return (
    <>
      <div className="page-header">
        <div className="page-title-section">
          <span className="page-kicker">Asset Identification</span>
          <h1 className="page-title">QR Security Stickers</h1>
          <span className="page-subtitle">Print individual barcode tags or scan code labels to trace items</span>
        </div>
      </div>

      <div className="dashboard-grid-secondary">
        {/* QR Scanner */}
        <div className="card">
          <span className="card-title">Secure Mobile QR Scanner</span>
          <div className="qr-scanner-box">
            {isWebcamScanning ? (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                <div id="reader" style={{ width: '100%', maxWidth: '350px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden' }}></div>
                <button className="btn btn-secondary" onClick={() => setIsWebcamScanning(false)} style={{ width: '100%' }}>
                  Cancel Camera Scan
                </button>
              </div>
            ) : (
              <>
                {isScanning && <div className="scanner-laser"></div>}
                <QrCode size={64} style={{ color: isScanning ? 'var(--secondary)' : 'var(--primary)' }} />
                <p style={{ fontSize: '13px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  {isScanning ? "Scanning simulated camera feed..." : "Scan with camera, or select an asset below to test:"}
                </p>

                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button className="btn btn-primary" onClick={() => setIsWebcamScanning(true)} style={{ width: '100%', marginBottom: '4px' }}>
                    Activate Webcam Scanner
                  </button>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <CustomSelect
                      options={[
                        { value: "", label: "-- Choose Asset Tag to Scan --" },
                        ...assets.map(a => ({ value: a.id, label: `${a.id} - ${a.name}` }))
                      ]}
                      value={scannerSelectedAssetId}
                      onChange={(e) => setScannerSelectedAssetId(e.target.value)}
                      disabled={isScanning}
                      style={{ flexGrow: 1 }}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleSimulateScan(scannerSelectedAssetId)}
                      disabled={isScanning || !scannerSelectedAssetId}
                    >
                      Simulate Scan
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <span className="card-title">Barcode Specifications</span>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            AssetFlow security tags feature unique QR codes embedded with cryptographic JSON specs for quick asset lookup, and high-contrast CSS barcode arrays for handheld scanner compatibility.
          </p>
          <button className="btn btn-secondary" onClick={() => window.print()}>
            Print Tag Inventory Sheets
          </button>
        </div>
      </div>

      {/* Printable stickers preview list */}
      <div className="card" style={{ marginTop: '16px' }}>
        <span className="card-title">Tag Sticker Sheet Layout (Printable)</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', justifyContent: 'center', padding: '12px' }}>
          {assets.filter(a => a.status !== 'Disposed').map(asset => (
            <QRCodeSticker key={asset.id} asset={asset} />
          ))}
        </div>
      </div>
    </>
  );
}
