import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Key, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../api';

export default function SystemReset({ addToast, currentRole }) {
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [showFinalModal, setShowFinalModal] = useState(false);
  
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  if (currentRole !== 'Super Admin') {
    return (
      <div className="card" style={{ padding: '24px', color: 'var(--status-disposed)', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <AlertTriangle size={20} />
        <span>Access Denied: System Reset is only accessible to the Super Administrator.</span>
      </div>
    );
  }

  const handleStartReset = () => {
    setError('');
    setPassword('');
    setShowPasswordModal(true);
  };

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    if (!password) {
      setError('Password is required.');
      return;
    }
    setShowPasswordModal(false);
    setShowWarningModal(true);
  };

  const handleWarningConfirm = () => {
    setShowWarningModal(false);
    setConfirmWord('');
    setShowFinalModal(true);
  };

  const executeReset = async () => {
    if (confirmWord !== 'RESET') {
      setError('Confirmation word does not match.');
      return;
    }

    setLoading(true);
    setError('');
    setProgress('Wiping remote Convex records...');
    
    try {
      // Call backend API
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({ password })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'System reset failed');
      }

      setProgress('Clearing local caches and client-side storage...');
      
      // Clear localStorage & sessionStorage
      localStorage.clear();
      sessionStorage.clear();

      // Clear IndexedDB databases
      if (window.indexedDB && window.indexedDB.databases) {
        try {
          const dbs = await window.indexedDB.databases();
          dbs.forEach(db => {
            window.indexedDB.deleteDatabase(db.name);
          });
        } catch (dbErr) {
          console.error('Failed to clear IndexedDB databases:', dbErr);
        }
      }

      addToast?.('System Reset Successful', 'The system was completely reset to a clean state. Refreshing...', 'success');
      
      setProgress('Refreshing application...');
      setTimeout(() => {
        window.location.hash = '#/dashboard';
        window.location.reload();
      }, 1500);

    } catch (err) {
      console.error(err);
      setError(err.message || 'System reset failed. Please check your credentials.');
      setLoading(false);
      setShowFinalModal(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '600px' }}>
      <div className="card" style={{ border: '1px solid var(--status-disposed)', padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <AlertTriangle size={24} style={{ color: 'var(--status-disposed)' }} />
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--status-disposed)' }}>
            System Reset (Destructive Action)
          </h3>
        </div>

        <p style={{ fontSize: '14px', color: 'var(--text-normal)', lineHeight: 1.5, marginBottom: '20px' }}>
          This operation will completely reset the application database. It removes all business assets, 
          allocations, support tickets, maintenance agreements, invoices, audit logs, locations, vendors, 
          and user accounts. <strong>Only the default Super Administrator account and system settings will remain.</strong>
        </p>

        {error && (
          <div style={{ padding: '12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--status-disposed)', borderRadius: 'var(--radius-md)', color: 'var(--status-disposed)', fontSize: '13px', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        <button 
          onClick={handleStartReset} 
          className="btn" 
          disabled={loading}
          style={{ background: 'var(--status-disposed)', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : null}
          Reset System
        </button>
      </div>

      {/* STEP 1: Password Confirmation Modal */}
      <AnimatePresence>
        {showPasswordModal && (
          <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="modal-card" style={{ maxWidth: '400px', width: '100%', padding: '24px', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <Key size={18} />
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Confirm Admin Password</h3>
              </div>
              <form onSubmit={handlePasswordSubmit}>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                  Please enter your Super Administrator password to verify identity before initiating a reset.
                </p>
                <input 
                  type="password" 
                  className="form-input" 
                  value={password} 
                  onChange={(e) => setPassword(e.target.value)} 
                  placeholder="Super Admin Password" 
                  required 
                  autoFocus
                  style={{ marginBottom: '20px', width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowPasswordModal(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Verify Password</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* STEP 2: General Warning Dialog */}
      <AnimatePresence>
        {showWarningModal && (
          <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="modal-card" style={{ maxWidth: '450px', width: '100%', padding: '24px', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: 'var(--status-disposed)' }}>
                <AlertTriangle size={20} />
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Are you absolutely sure?</h3>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-normal)', lineHeight: 1.5, marginBottom: '20px' }}>
                This is a <strong>non-reversible</strong> action. Wiping all database files and resetting Convex tables cannot be undone. All audit trails, files, and users will be permanently deleted.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowWarningModal(false)}>Cancel</button>
                <button type="button" className="btn" style={{ background: 'var(--status-disposed)', color: '#fff', border: 'none' }} onClick={handleWarningConfirm}>
                  I Understand, Continue
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* STEP 3: Final Challenge Dialog (Type RESET) */}
      <AnimatePresence>
        {showFinalModal && (
          <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="modal-card" style={{ maxWidth: '450px', width: '100%', padding: '24px', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: 'var(--status-disposed)' }}>
                <AlertTriangle size={20} />
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Final Confirmation</h3>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-normal)', marginBottom: '16px' }}>
                To proceed, please type <strong style={{ color: 'var(--status-disposed)' }}>RESET</strong> in the field below:
              </p>
              <input 
                type="text" 
                className="form-input" 
                value={confirmWord} 
                onChange={(e) => setConfirmWord(e.target.value)} 
                placeholder="Type RESET here" 
                required 
                autoFocus
                style={{ marginBottom: '20px', width: '100%', textTransform: 'uppercase' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowFinalModal(false)}>Cancel</button>
                <button 
                  type="button" 
                  className="btn" 
                  disabled={confirmWord !== 'RESET'}
                  style={{ background: confirmWord === 'RESET' ? 'var(--status-disposed)' : 'var(--button-disabled)', color: '#fff', border: 'none' }} 
                  onClick={executeReset}
                >
                  Confirm Full Reset
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Progress Modal */}
      <AnimatePresence>
        {loading && progress && (
          <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.85)', zIndex: 1001 }}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="modal-card" style={{ maxWidth: '350px', width: '100%', padding: '32px', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
              <RefreshCw size={36} className="animate-spin" style={{ color: 'var(--primary-color)' }} />
              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>Resetting System Status</h4>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{progress}</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
