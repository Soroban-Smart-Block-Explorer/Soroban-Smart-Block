/**
 * Email Service
 *
 * Handles sending emails using either:
 * - Resend (if RESEND_API_KEY is set)
 * - Nodemailer with SMTP (if SMTP_* env vars are set)
 *
 * Supports sending verification emails for API key creation.
 */

import nodemailer from 'nodemailer';
import { Resend } from 'resend';

// ── Configuration ───────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@soroban-explorer.com';

// Determine which email service to use
let emailProvider = null;
let emailProviderName = 'none';

if (RESEND_API_KEY) {
  emailProvider = new Resend(RESEND_API_KEY);
  emailProviderName = 'resend';
} else if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
  emailProvider = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: SMTP_PORT === '465', // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  emailProviderName = 'smtp';
}

// ── Email Sending ───────────────────────────────────────────────────────────────

/**
 * Send an email using the configured provider.
 *
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject
 * @param {string} params.html - HTML email body
 * @param {string} [params.text] - Plain text email body (fallback)
 * @returns {Promise<void>}
 */
async function sendEmail({ to, subject, html, text }) {
  if (!emailProvider) {
    throw new Error('Email service not configured. Set RESEND_API_KEY or SMTP_* env vars.');
  }

  try {
    if (emailProviderName === 'resend') {
      await emailProvider.emails.send({
        from: SMTP_FROM,
        to,
        subject,
        html,
        text,
      });
    } else if (emailProviderName === 'smtp') {
      await emailProvider.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        html,
        text,
      });
    }
  } catch (error) {
    console.error('[EmailService] Failed to send email:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

// ── Verification Email Template ─────────────────────────────────────────────────

/**
 * Send a verification email for API key creation.
 *
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.keyName - Name of the API key
 * @param {string} params.verificationUrl - Full verification URL with token
 * @returns {Promise<void>}
 */
async function sendVerificationEmail({ email, keyName, verificationUrl }) {
  const subject = 'Verify your Soroban Explorer API Key';
  
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .button:hover { background: #5568d3; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
          .code { background: #f0f0f0; padding: 10px; border-radius: 5px; font-family: monospace; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔑 Verify Your API Key</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>You've requested to create an API key for the Soroban Smart Block Explorer:</p>
            <p><strong>Key Name:</strong> ${escapeHtml(keyName)}</p>
            <p>To activate your API key, please verify your email address by clicking the button below:</p>
            <center>
              <a href="${escapeHtml(verificationUrl)}" class="button">Verify Email & Activate Key</a>
            </center>
            <p>Or copy and paste this link into your browser:</p>
            <div class="code">${escapeHtml(verificationUrl)}</div>
            <p><strong>Important:</strong> This verification link will expire in 24 hours. After verification, your API key will be displayed once - make sure to save it securely.</p>
            <p>If you didn't request this API key, you can safely ignore this email.</p>
          </div>
          <div class="footer">
            <p>Soroban Smart Block Explorer</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const text = `
    Verify Your API Key
    ===================
    
    Hello,
    
    You've requested to create an API key for the Soroban Smart Block Explorer:
    
    Key Name: ${keyName}
    
    To activate your API key, please verify your email address by visiting:
    
    ${verificationUrl}
    
    Important: This verification link will expire in 24 hours. After verification, your API key will be displayed once - make sure to save it securely.
    
    If you didn't request this API key, you can safely ignore this email.
    
    Soroban Smart Block Explorer
  `;

  await sendEmail({ to: email, subject, html, text });
}

// ── Helper Functions ─────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Health Check ─────────────────────────────────────────────────────────────────

/**
 * Check if the email service is properly configured.
 * @returns {boolean}
 */
function isConfigured() {
  return emailProvider !== null;
}

/**
 * Get the name of the configured email provider.
 * @returns {string}
 */
function getProviderName() {
  return emailProviderName;
}

export {
  sendEmail,
  sendVerificationEmail,
  isConfigured,
  getProviderName,
};
