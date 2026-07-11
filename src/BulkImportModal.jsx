import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Download, FileUp, AlertCircle, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from './api';
import Modal from './Modal';
import { ROLE_ORDER } from './permissions';

const validateAndFormatPhone = (phone) => {
  if (!phone) return { isValid: true, value: '' };
  const cleaned = String(phone).replace(/[\s\-\(\)]/g, '');
  if (!cleaned) return { isValid: true, value: '' };

  if (cleaned.startsWith('+')) {
    const digitsOnly = cleaned.slice(1);
    if (/^\d{7,15}$/.test(digitsOnly)) {
      return { isValid: true, value: cleaned };
    }
    return { isValid: false, error: 'Invalid international phone format. Must be + followed by 7 to 15 digits.' };
  }

  if (/^\d{10}$/.test(cleaned)) {
    return { isValid: true, value: '+91' + cleaned };
  }

  if (/^91\d{10}$/.test(cleaned)) {
    return { isValid: true, value: '+' + cleaned };
  }

  return { isValid: false, error: 'Invalid phone format. Indian numbers require 10 digits. International numbers must start with +.' };
};

const BulkImportModal = ({ isOpen, onClose, type, onImportComplete, isApiConnected, usersList, assetsList, assetSubtypes = {} }) => {
  const [file, setFile] = useState(null);
  const [isParsing, setIsParsing] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [progress, setProgress] = useState(null);

  // Idempotency key for the employee import. It is minted once per selected file,
  // so retrying a slow or interrupted import resumes the original server-side job
  // rather than importing the same people twice. Choosing a new file mints a new key.
  const importKeyRef = useRef(null);
  const [errorLog, setErrorLog] = useState([]);

  if (!isOpen) return null;

  const downloadTemplate = () => {
    if (type === 'employees') {
      const headers = [
        ["Employee ID", "First Name", "Last Name", "Email", "Phone Number", "Department", "Designation", "Role", "Status"],
        ["EMP-101", "John", "Doe", "john.doe@company.com", "9876543210", "Engineering", "Software Engineer", "Employee", "Active"],
        ["EMP-102", "Jane", "Smith", "jane.smith@company.com", "9876543211", "HR", "HR Generalist", "Employee", "Active"],
        ["EMP-103", "Alice", "Johnson", "alice.johnson@company.com", "9876543212", "Finance", "Finance Lead", "Finance Team", "Active"],
        ["EMP-104", "Bob", "Smith", "bob.smith@company.com", "9876543213", "IT", "IT Specialist", "IT Admin", "Active"]
      ];
      const ws = XLSX.utils.aoa_to_sheet(headers);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Employees Template");
      XLSX.writeFile(wb, "employees_import_template.xlsx");
    } else if (type === 'assets') {
      const headers = [
        ["Asset ID", "Asset Name", "Category", "Asset Tag Subtype", "Brand", "Model", "Serial Number", "Quantity", "Unit", "Purchase Date", "Purchase Cost", "Supplier", "Warranty Expiry", "Department", "Associate Department", "Location", "Useful Lifespan", "Status"],
        ["AST-201", "MacBook Pro 16", "IT", "Laptop", "Apple", "M3 Max 16-inch", "C02F87DKMD6R", "10", "pcs", "2026-06-10", "2400.00", "Apple Business", "2027-06-10", "Engineering", "IT", "New York HQ", "5", "Available"],
        ["AST-202", "Herman Miller Chair", "Office", "Chair", "Herman Miller", "Aeron Size B", "HM-AER-98273", "50", "pcs", "2026-05-18", "1200.00", "OfficeSolutions", "2031-05-18", "Operations", "Facilities", "London HQ", "10", "Available"],
        ["AST-203", "Dell IPS Monitor 24", "IT", "Monitor", "Dell", "U2412M", "CN-0V2D6M-89102", "15", "pcs", "2026-04-20", "220.00", "TechDistributors", "2029-04-20", "Engineering", "", "London HQ", "", "Available"]
      ];
      const ws = XLSX.utils.aoa_to_sheet(headers);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Assets Template");
      XLSX.writeFile(wb, "assets_import_template.xlsx");
    } else if (type === 'invoices') {
      const headers = [
        ["Invoice ID", "PO Reference", "Vendor Business Name", "Base Value", "GST Percentage", "Issue Date", "Payment Status", "PDF Filename"],
        ["INV-2026-001", "PO-2026-99", "Dell Commercial Sales", "50000.00", "18", "2026-07-09", "Pending", ""]
      ];
      const ws = XLSX.utils.aoa_to_sheet(headers);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Invoices Template");
      XLSX.writeFile(wb, "invoices_import_template.xlsx");
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setImportSummary(null);
      setErrorLog([]);
      setProgress(null);
      importKeyRef.current = null; // a different file is a different import
    }
  };

  const handleImport = async () => {
    if (!file) return;

    setIsParsing(true);
    setErrorLog([]);
    setImportSummary(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (rows.length === 0) {
          setErrorLog([{ row: 'General', error: 'The file does not contain any records.' }]);
          setIsParsing(false);
          return;
        }

        if (type === 'employees') {
          const mappedEmployees = rows.map((row) => ({
            employeeId: String(row['Employee ID'] || row['employeeId'] || row['id'] || row['ID'] || '').trim(),
            firstName: String(row['First Name'] || row['firstName'] || row['first_name'] || '').trim(),
            lastName: String(row['Last Name'] || row['lastName'] || row['last_name'] || '').trim(),
            email: String(row['Email'] || row['email'] || '').trim(),
            phoneNumber: String(row['Phone Number'] || row['phoneNumber'] || row['phone_number'] || row['Phone'] || '').trim(),
            department: String(row['Department'] || row['department'] || '').trim(),
            designation: String(row['Designation'] || row['designation'] || '').trim(),
            role: String(row['Role'] || row['role'] || 'Employee').trim(),
            status: String(row['Status'] || row['status'] || 'Active').trim()
          }));

          if (isApiConnected) {
            try {
              if (!importKeyRef.current) {
                importKeyRef.current = `${file.name}:${file.size}:${file.lastModified}:${Date.now()}`;
              }
              setProgress({ processed: 0, total: mappedEmployees.length });
              const res = await api.importEmployees(mappedEmployees, {
                importKey: importKeyRef.current,
                onProgress: setProgress
              });
              setImportSummary(res);
              setErrorLog(res.errors || []);
              if (res.success > 0) {
                onImportComplete();
              }
            } catch (err) {
              console.error('Error in importEmployees:', err);
              setErrorLog([{ row: 'Import failed', error: err.message || 'The import could not be completed.' }]);
            } finally {
              setProgress(null);
            }
          } else {
            // Local Offline Mode
            const errors = [];
            let success = 0;
            let failed = 0;
            let duplicate = 0;
            const updatedUsers = [...(usersList || [])];

            mappedEmployees.forEach((emp, index) => {
              const rowNum = index + 1;
              const rowErrs = [];

              if (!emp.employeeId) rowErrs.push("Employee ID is required");
              if (!emp.firstName) rowErrs.push("First Name is required");
              if (!emp.lastName) rowErrs.push("Last Name is required");
              if (!emp.email) {
                rowErrs.push("Email is required");
              } else if (!/\S+@\S+\.\S+/.test(emp.email)) {
                rowErrs.push("Invalid email format");
              }

              if (emp.phoneNumber) {
                const phoneValidation = validateAndFormatPhone(emp.phoneNumber);
                if (!phoneValidation.isValid) {
                  rowErrs.push(phoneValidation.error);
                } else {
                  emp.phoneNumber = phoneValidation.value;
                }
              }

              if (!ROLE_ORDER.includes(emp.role)) {
                rowErrs.push(`Invalid role: must be one of ${ROLE_ORDER.join(', ')}`);
              }

              if (rowErrs.length > 0) {
                failed++;
                errors.push({ row: rowNum, employeeId: emp.employeeId, error: rowErrs.join(', ') });
                return;
              }

              // Duplication check in payload
              const isPayloadDup = mappedEmployees.slice(0, index).some(x => x.employeeId.toLowerCase() === emp.employeeId.toLowerCase() || x.email.toLowerCase() === emp.email.toLowerCase());
              if (isPayloadDup) {
                duplicate++;
                errors.push({ row: rowNum, employeeId: emp.employeeId, error: `Employee ID '${emp.employeeId}' already exists. Please use a unique Employee ID.` });
                return;
              }

              // Duplication check in local list
              const isDbIdDup = updatedUsers.some(u => String(u.employeeId || '').toLowerCase() === emp.employeeId.toLowerCase());
              const isDbEmailDup = updatedUsers.some(u => String(u.email || '').toLowerCase() === emp.email.toLowerCase());

              if (isDbIdDup) {
                duplicate++;
                errors.push({ row: rowNum, employeeId: emp.employeeId, error: `Employee ID '${emp.employeeId}' already exists. Please use a unique Employee ID.` });
                return;
              }
              if (isDbEmailDup) {
                duplicate++;
                errors.push({ row: rowNum, employeeId: emp.employeeId, error: `Email "${emp.email}" already exists` });
                return;
              }

              const baseUsername = emp.email.split('@')[0];
              let generatedUsername = baseUsername;
              let suffix = 1;
              while (true) {
                const exists = updatedUsers.some(u => String(u.username || '').toLowerCase() === generatedUsername.toLowerCase());
                if (exists) {
                  generatedUsername = baseUsername + suffix;
                  suffix++;
                  continue;
                }
                break;
              }
              const username = generatedUsername;

              updatedUsers.push({
                id: Date.now() + index,
                username,
                name: `${emp.firstName} ${emp.lastName}`,
                email: emp.email,
                role: emp.role,
                employeeId: emp.employeeId,
                phoneNumber: emp.phoneNumber,
                department: emp.department,
                designation: emp.designation,
                status: emp.status,
                created_at: new Date().toISOString()
              });
              success++;
            });

            setImportSummary({
              total: mappedEmployees.length,
              success,
              failed,
              duplicate,
              errors
            });
            setErrorLog(errors);
            if (success > 0) {
              onImportComplete(updatedUsers);
            }
          }
        } else if (type === 'assets') {
          // Asset bulk import
          const mappedAssets = rows.map((row) => {
            const rawLifespan = row['Useful Lifespan'] ?? row['usefulLifespan'] ?? row['Useful Life'] ?? row['depreciationLifeYears'];
            return {
              assetId: String(row['Asset ID'] || row['assetId'] || row['id'] || row['ID'] || '').trim(),
              name: String(row['Asset Name'] || row['name'] || row['AssetName'] || '').trim(),
              category: String(row['Category'] || row['category'] || 'IT').trim(),
              // Asset Tag Subtype (a.k.a. Item Type) — driven by master data, no longer
              // derived from the category.
              type: String(row['Asset Tag Subtype'] || row['Item Type'] || row['Type'] || row['type'] || row['Subtype'] || '').trim(),
              brand: String(row['Brand'] || row['brand'] || '').trim(),
              model: String(row['Model'] || row['model'] || '').trim(),
              serialNumber: row['Serial Number'] || row['serialNumber'] || row['serial_number'] ? String(row['Serial Number'] || row['serialNumber'] || row['serial_number']).trim() : null,
              quantity: parseInt(row['Quantity'] || row['quantity']) || 1,
              unit: String(row['Unit'] || row['unit'] || 'pcs').trim(),
              purchaseDate: row['Purchase Date'] || row['purchaseDate'] || null,
              purchaseCost: parseFloat(row['Purchase Cost'] || row['purchaseCost'] || row['cost']) || 0,
              supplier: String(row['Supplier'] || row['supplier'] || '').trim(),
              warrantyExpiry: row['Warranty Expiry'] || row['warrantyExpiry'] || null,
              department: String(row['Department'] || row['department'] || '').trim(),
              associateDepartment: String(row['Associate Department'] || row['associateDepartment'] || row['associate_department'] || '').trim(),
              // Useful Lifespan is optional — a blank cell stays null.
              depreciationLifeYears: rawLifespan === undefined || rawLifespan === null || String(rawLifespan).trim() === ''
                ? null
                : parseInt(rawLifespan),
              location: String(row['Location'] || row['location'] || '').trim(),
              status: String(row['Status'] || row['status'] || 'Available').trim()
            };
          });

          if (isApiConnected) {
            try {
              const res = await api.importAssets(mappedAssets);
              setImportSummary(res);
              setErrorLog(res.errors || []);
              if (res.success > 0) {
                onImportComplete();
              }
            } catch (err) {
              setErrorLog([{ row: 'Transaction Rollback', error: err.message || 'Unexpected rollback occurred.' }]);
            }
          } else {
            // Local Offline Mode
            const errors = [];
            let success = 0;
            let failed = 0;
            let duplicate = 0;
            const updatedAssets = [...(assetsList || [])];

            mappedAssets.forEach((ast, index) => {
              const rowNum = index + 1;
              const rowErrs = [];

              if (!ast.assetId) rowErrs.push("Asset ID is required");
              if (!ast.name) rowErrs.push("Asset Name is required");
              if (ast.category !== 'IT' && ast.category !== 'Office') {
                rowErrs.push("Category must be 'IT' or 'Office'");
              }

              // Validate the Item Type against master data (same rule as the server),
              // when a subtype was provided and a catalogue exists for the category.
              const validForCat = (assetSubtypes[ast.category] || []).map(s => s.toLowerCase());
              if (ast.type && validForCat.length && !validForCat.includes(ast.type.toLowerCase())) {
                rowErrs.push(`"${ast.type}" is not a valid Asset Tag Subtype for category "${ast.category}"`);
              }
              if (ast.depreciationLifeYears !== null && (Number.isNaN(ast.depreciationLifeYears) || ast.depreciationLifeYears < 0)) {
                rowErrs.push("Useful Lifespan must be a non-negative whole number");
              }

              if (rowErrs.length > 0) {
                failed++;
                errors.push({ row: rowNum, assetId: ast.assetId, error: rowErrs.join(', ') });
                return;
              }

              const isPayloadDup = mappedAssets.slice(0, index).some(x => x.assetId === ast.assetId);
              if (isPayloadDup) {
                duplicate++;
                errors.push({ row: rowNum, assetId: ast.assetId, error: "Duplicate in import sheet" });
                return;
              }

              const isDbDup = updatedAssets.some(a => String(a.id) === ast.assetId);
              if (isDbDup) {
                duplicate++;
                errors.push({ row: rowNum, assetId: ast.assetId, error: `Asset ID "${ast.assetId}" already exists` });
                return;
              }

              updatedAssets.push({
                id: ast.assetId,
                name: ast.name,
                category: ast.category,
                type: ast.type,
                brand: ast.brand,
                model: ast.model,
                serialNumber: ast.serialNumber,
                totalQuantity: ast.quantity,
                availableQuantity: ast.quantity,
                assignedQuantity: 0,
                unit: ast.unit,
                purchaseDate: ast.purchaseDate,
                cost: ast.purchaseCost,
                supplier: ast.supplier,
                warrantyExpiry: ast.warrantyExpiry,
                department: ast.department,
                associateDepartment: ast.associateDepartment,
                depreciationLifeYears: ast.depreciationLifeYears,
                location: ast.location,
                status: ast.status,
                assignedEmployee: '',
                notes: ''
              });
              success++;
            });

            setImportSummary({
              total: mappedAssets.length,
              success,
              failed,
              duplicate,
              errors
            });
            setErrorLog(errors);
            if (success > 0) {
              onImportComplete(updatedAssets);
            }
          }
        } else if (type === 'invoices') {
          // Invoices bulk import
          const mappedInvoices = rows.map((row) => ({
            id: String(row['Invoice ID'] || row['invoiceId'] || row['id'] || row['ID'] || '').trim(),
            poReference: String(row['PO Reference'] || row['poReference'] || row['po_reference'] || '').trim(),
            vendor: String(row['Vendor Business Name'] || row['vendor'] || row['Vendor'] || '').trim(),
            amount: parseFloat(row['Base Value'] || row['amount'] || row['cost']) || 0,
            gst: parseInt(row['GST Percentage'] || row['gst'] || '0') || 0,
            date: row['Issue Date'] || row['date'] || null,
            paymentStatus: String(row['Payment Status'] || row['paymentStatus'] || row['payment_status'] || 'Pending').trim(),
            fileName: String(row['PDF Filename'] || row['fileName'] || row['file_name'] || '').trim()
          }));

          if (isApiConnected) {
            try {
              const res = await api.bulkImportInvoices(mappedInvoices);
              setImportSummary({
                total: res.successCount + res.failedCount,
                success: res.successCount,
                failed: res.failedCount,
                duplicate: res.errors.filter(e => e.error.includes('already exists') || e.error.includes('Duplicate')).length,
                errors: res.errors
              });
              setErrorLog(res.errors || []);
              if (res.successCount > 0) {
                onImportComplete();
              }
            } catch (err) {
              setErrorLog([{ row: 'Transaction Rollback', error: err.message || 'Unexpected rollback occurred.' }]);
            }
          } else {
            // Local Offline Mode
            const errors = [];
            let success = 0;
            let failed = 0;
            let duplicate = 0;
            const updatedInvoices = [...(assetsList || [])];

            mappedInvoices.forEach((inv, index) => {
              const rowNum = index + 1;
              const rowErrs = [];

              if (!inv.id) rowErrs.push("Invoice ID is required");
              if (!inv.vendor) rowErrs.push("Vendor Business Name is required");

              if (rowErrs.length > 0) {
                failed++;
                errors.push({ row: rowNum, id: inv.id || 'N/A', error: rowErrs.join(', ') });
                return;
              }

              const isPayloadDup = mappedInvoices.slice(0, index).some(x => x.id && x.id.trim().toLowerCase() === inv.id.trim().toLowerCase());
              if (isPayloadDup) {
                duplicate++;
                errors.push({ row: rowNum, id: inv.id, error: "Duplicate Invoice ID in import sheet" });
                return;
              }

              const isDbDup = updatedInvoices.some(i => i.id && i.id.trim().toLowerCase() === inv.id.trim().toLowerCase());
              if (isDbDup) {
                duplicate++;
                errors.push({ row: rowNum, id: inv.id, error: `Invoice ID "${inv.id}" already exists` });
                return;
              }

              updatedInvoices.push({
                id: inv.id,
                poReference: inv.poReference,
                vendor: inv.vendor,
                amount: inv.amount,
                gst: inv.gst,
                date: inv.date || new Date().toISOString().split('T')[0],
                paymentStatus: inv.paymentStatus,
                fileName: inv.fileName,
                createdAt: new Date().toISOString()
              });
              success++;
            });

            setImportSummary({
              total: mappedInvoices.length,
              success,
              failed,
              duplicate,
              errors
            });
            setErrorLog(errors);
            if (success > 0) {
              onImportComplete(updatedInvoices);
            }
          }
        }
      } catch (err) {
        setErrorLog([{ row: 'Parsing Error', error: 'Failed to process file: ' + err.message }]);
      } finally {
        setIsParsing(false);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      closeDisabled={isParsing}
      closeOnEscape={!isParsing}
      title={`Bulk Import ${type === 'employees' ? 'Employees Directory' : type === 'assets' ? 'Inventory Assets' : 'Purchase Invoices'}`}
      maxWidth="600px"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={isParsing}>Cancel / Exit</button>
          <button type="button" className="btn btn-primary" onClick={handleImport} disabled={!file || isParsing} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FileUp size={15} />
            Execute Bulk Import
          </button>
        </>
      }
    >
          <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)' }}>
            Upload an Excel (.xlsx) or CSV file with the structured template columns. You can download the pre-configured blank template below.
          </p>

          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
            <button className="btn btn-secondary" onClick={downloadTemplate} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Download size={15} />
              Download Blank Template (.xlsx)
            </button>
          </div>

          <div style={{ border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '32px 20px', textAlign: 'center', background: 'var(--bg-sidebar)', cursor: 'pointer', position: 'relative' }}>
            <input type="file" accept=".xlsx, .csv" onChange={handleFileChange} style={{ opacity: 0, position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', cursor: 'pointer' }} disabled={isParsing} />
            <FileUp size={36} style={{ color: 'var(--primary)', marginBottom: '12px' }} />
            {file ? (
              <p style={{ fontWeight: '600', fontSize: '14px' }}>Selected File: <span style={{ color: 'var(--primary)' }}>{file.name}</span></p>
            ) : (
              <p style={{ fontWeight: '500', fontSize: '13px', color: 'var(--text-muted)' }}>Drag & drop or click to choose Excel/CSV file</p>
            )}
          </div>

          {isParsing && (
            <div style={{ marginTop: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--primary)' }}>
                <RefreshCw className="animate-spin" size={16} />
                <span>
                  {progress && progress.total > 0
                    ? `Importing ${progress.processed} of ${progress.total} employees…`
                    : 'Parsing and validating records...'}
                </span>
              </div>
              {progress && progress.total > 0 && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.processed}
                  aria-label="Employee import progress"
                  style={{
                    marginTop: '12px',
                    height: '6px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--border-color)',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((progress.processed / progress.total) * 100)}%`,
                      height: '100%',
                      background: 'var(--accent-gradient)',
                      borderRadius: 'var(--radius-full)',
                      transition: 'width 300ms cubic-bezier(0.16, 1, 0.3, 1)'
                    }}
                  />
                </div>
              )}
              <p style={{ marginTop: '10px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
                This runs on the server — it is safe to wait. Retrying will not import anyone twice.
              </p>
            </div>
          )}

          {importSummary && (
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: '700', marginTop: '24px', marginBottom: '12px' }}>Import Operation Results</h4>
              <div className="import-summary-container">
                <div className="import-summary-card">
                  <div className="import-summary-val" style={{ color: 'var(--primary)' }}>{importSummary.total}</div>
                  <div className="import-summary-lbl">Total Processed</div>
                </div>
                <div className="import-summary-card">
                  <div className="import-summary-val" style={{ color: 'var(--status-available)' }}>{importSummary.success}</div>
                  <div className="import-summary-lbl">Successfully Imported</div>
                </div>
                <div className="import-summary-card">
                  <div className="import-summary-val" style={{ color: 'var(--status-disposed)' }}>{importSummary.failed}</div>
                  <div className="import-summary-lbl">Failed Validation</div>
                </div>
                <div className="import-summary-card">
                  <div className="import-summary-val" style={{ color: 'var(--status-maintenance)' }}>{importSummary.duplicate}</div>
                  <div className="import-summary-lbl">Duplicate Records</div>
                </div>
              </div>
              
              {importSummary.generatedPasswords && importSummary.generatedPasswords.length > 0 && (
                <div style={{ marginTop: '20px', background: 'rgba(99, 44, 237, 0.05)', border: '1px solid rgba(99, 44, 237, 0.2)', borderRadius: '8px', padding: '16px' }}>
                  <h5 style={{ fontSize: '13px', fontWeight: '700', margin: '0 0 10px', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    🔑 Secure Temporary Passwords Generated
                  </h5>
                  <p style={{ margin: '0 0 12px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                    Copy these temporary credentials for the imported employees. They will be prompted to change them on first login:
                  </p>
                  <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--bg-main)' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', textAlign: 'left' }}>
                          <th style={{ padding: '6px 10px', fontWeight: '600' }}>Username</th>
                          <th style={{ padding: '6px 10px', fontWeight: '600' }}>Full Name</th>
                          <th style={{ padding: '6px 10px', fontWeight: '600' }}>Temporary Password</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importSummary.generatedPasswords.map((p, idx) => (
                          <tr key={idx} style={{ borderBottom: idx < importSummary.generatedPasswords.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--mono)', fontWeight: '600', color: 'var(--primary)' }}>{p.username}</td>
                            <td style={{ padding: '6px 10px' }}>{p.name}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--mono)', color: 'var(--status-assigned)', userSelect: 'all' }}>{p.tempPassword}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {errorLog.length > 0 && (
            <div className="import-error-log">
              <div className="import-error-title">
                <AlertTriangle size={16} />
                <span>Row-Level Import Validation Faults ({errorLog.length})</span>
              </div>
              <ul className="import-error-list">
                {errorLog.map((err, idx) => (
                  <li key={idx} className="import-error-item">
                    <span className="import-error-row">Row {err.row}:</span>
                    <span style={{ color: 'var(--text-primary)' }}>{err.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
    </Modal>
  );
};

export default BulkImportModal;
