import nodemailer from "nodemailer";
import type { Mailer, MailMessage } from "@painel/core";

// Envio por SMTP da própria instalação (self-hosted, ADR-015). SMTP_URL no formato
// smtp://usuario:senha@host:587 (STARTTLS) ou smtps://usuario:senha@host:465 (TLS direto).
// A senha fica só na variável de ambiente; nunca vai para log nem para o banco.

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(message: MailMessage) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
    },
  };
}

/** Tira usuário e senha do endereço antes de escrever no log. */
export function describeSmtp(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "endereço SMTP inválido";
  }
}
