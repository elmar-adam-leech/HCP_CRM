import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import ReactMarkdown from "react-markdown";

type PrivacyNoticeResponse = {
  privacyNoticeMarkdown: string | null;
};

function DefaultPrivacyContent() {
  return (
    <>
      <p className="mb-6">
        This Privacy Policy describes how <strong>HCP CRM</strong> ("we," "us," or "our"), operating
        the service at <strong>hcpcrm.com</strong>, collects, uses, and protects information when you use
        our customer relationship management (CRM) platform (the "Service"). By using the Service, you
        agree to the practices described in this policy.
      </p>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">1. Information We Collect</h2>
        <p className="mb-3">We collect the following categories of information:</p>
        <ul className="list-disc pl-6 space-y-2 text-foreground">
          <li>
            <strong>Account information:</strong> Name, email address, and password when you register.
          </li>
          <li>
            <strong>Contact and lead data:</strong> Names, email addresses, phone numbers, and addresses
            of your customers and prospects that you store in the Service.
          </li>
          <li>
            <strong>Gmail data (via Google OAuth):</strong> When you connect your Google account, we
            request access under the following OAuth scopes:
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>
                <code className="bg-muted px-1 rounded text-sm">https://www.googleapis.com/auth/gmail.readonly</code> —
                read your email messages and metadata to import leads and conversation history.
              </li>
              <li>
                <code className="bg-muted px-1 rounded text-sm">https://www.googleapis.com/auth/gmail.send</code> —
                send emails on your behalf from within the CRM.
              </li>
              <li>
                <code className="bg-muted px-1 rounded text-sm">https://www.googleapis.com/auth/gmail.modify</code> —
                mark messages as read or apply labels to messages we have processed.
              </li>
            </ul>
            <p className="mt-2">
              Access to Gmail is used solely to provide CRM functionality — reading inbound lead emails,
              displaying email threads, and sending replies. We do not scan your email for advertising
              purposes.
            </p>
          </li>
          <li>
            <strong>Usage data:</strong> Log data such as IP address, browser type, pages visited, and
            timestamps, collected automatically when you access the Service.
          </li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">2. How We Use Your Information</h2>
        <p className="mb-3">We use the information we collect to:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Provide, maintain, and improve the Service.</li>
          <li>
            Process Gmail data to identify and import leads, display email conversations, and send
            outbound emails on your behalf.
          </li>
          <li>Authenticate your account and keep it secure.</li>
          <li>Send transactional notifications such as password resets.</li>
          <li>Respond to your support requests.</li>
          <li>Comply with legal obligations.</li>
        </ul>
        <p className="mt-3">
          We do <strong>not</strong> use Gmail data or any personal data for advertising, profiling, or
          any purpose beyond operating the Service for you.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">3. Google API Services — Limited Use Disclosure</h2>
        <p className="mb-3">
          Our use of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline text-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>
          Specifically: Gmail data is read only to display lead information and email threads inside the
          CRM dashboard. It is not transferred to third parties except as necessary to provide the
          Service (e.g., storing email content in our database for you to view), and it is never used for
          serving advertisements.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">4. Data Controller &amp; Processor Roles</h2>
        <p className="mb-3">
          Each business ("tenant") that uses HCP CRM is the <strong>data controller</strong> for the
          contact and lead data they store. HCP CRM acts as a <strong>data processor</strong>, processing
          personal data on behalf of and under instruction from the tenant. Tenants are responsible for
          obtaining proper consent from their contacts and for responding to data subject requests.
        </p>
        <p>
          HCP CRM provides tools (data export, erasure, and consent logs) to help tenants comply with
          applicable privacy regulations including GDPR and CCPA.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">5. Data Retention</h2>
        <p className="mb-3">
          We retain your account data and CRM data for as long as your account is active. Each tenant
          can configure a data retention period in their Privacy settings. Contacts whose last activity
          exceeds the configured retention period are flagged for review. Administrators can then review
          and erase or retain flagged contacts.
        </p>
        <p>
          If you delete your account, we will delete or anonymize your personal data within 30 days,
          except where retention is required by law. Gmail OAuth tokens are stored only while your Google
          account remains connected; you may revoke access at any time via your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="underline text-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Account permissions
          </a>
          .
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">6. Data Hosting &amp; Infrastructure</h2>
        <p>
          All data is stored on servers hosted in the United States. Our primary database is hosted on
          Neon (PostgreSQL). Data in transit is encrypted using TLS, and data at rest is encrypted at the
          storage layer by our hosting providers.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">7. Third-Party Sharing</h2>
        <p className="mb-3">
          We do <strong>not</strong> sell, rent, or share your personal data with third parties for their
          own marketing or advertising purposes. We may share data only in the following limited
          circumstances:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Service providers:</strong> Trusted vendors who help us operate the Service (e.g.,
            cloud hosting, email delivery). These vendors are contractually obligated to process data only
            on our behalf.
          </li>
          <li>
            <strong>Legal requirements:</strong> When disclosure is required by law, court order, or to
            protect the rights, property, or safety of our users or the public.
          </li>
          <li>
            <strong>Business transfers:</strong> In connection with a merger, acquisition, or sale of
            assets, in which case we will notify you before your data is transferred and becomes subject
            to a different privacy policy.
          </li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">8. Security</h2>
        <p>
          We implement industry-standard technical and organizational measures to protect your data
          against unauthorized access, alteration, disclosure, or destruction. However, no method of
          transmission over the Internet is 100% secure, and we cannot guarantee absolute security.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">9. Your Rights (GDPR &amp; CCPA)</h2>
        <p className="mb-3">Under applicable privacy laws, you have the right to:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Access:</strong> Request a copy of the personal data we hold about you. Administrators can export a full data bundle from the Contacts page.</li>
          <li><strong>Rectification:</strong> Request correction of inaccurate data.</li>
          <li><strong>Erasure / Deletion:</strong> Request deletion or anonymization of your data (subject to legal retention requirements). Administrators can erase contact data from the Contacts page with a documented reason.</li>
          <li><strong>Portability:</strong> Receive your data in a structured, machine-readable JSON format.</li>
          <li><strong>Opt-out of sale (CCPA):</strong> We do not sell personal information. No opt-out is required.</li>
          <li>Revoke Gmail OAuth access at any time through your Google Account settings.</li>
          <li>Object to or restrict certain processing of your data.</li>
        </ul>
        <p className="mt-3">
          <strong>How to exercise your rights:</strong> Contact the business (tenant) that collected your
          information. If you are a tenant administrator, use the Data &amp; Privacy section in Settings
          or the export/erase tools on the Contacts page. You may also email us at{" "}
          <a href="mailto:privacy@hcpcrm.com" className="underline text-primary">privacy@hcpcrm.com</a>{" "}
          and we will respond within 30 days.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">10. Children's Privacy</h2>
        <p>
          The Service is not directed to children under 13. We do not knowingly collect personal
          information from children. If you believe a child has provided us personal information, please
          contact us and we will delete it promptly.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">11. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of material changes by
          posting the new policy on this page with an updated effective date. Your continued use of the
          Service after changes take effect constitutes acceptance of the updated policy.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">12. Contact Us</h2>
        <p>
          If you have questions about this Privacy Policy, please contact us at:{" "}
          <a href="mailto:privacy@hcpcrm.com" className="underline text-primary">
            privacy@hcpcrm.com
          </a>
        </p>
      </section>
    </>
  );
}

export default function PrivacyPolicy() {
  const params = useParams<{ slug?: string }>();
  const slug = params?.slug;

  const { data, isLoading } = useQuery<PrivacyNoticeResponse>({
    queryKey: ["/api/public/privacy-notice", slug],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/public/privacy-notice/${slug}`);
      return res.json() as Promise<PrivacyNoticeResponse>;
    },
    enabled: !!slug,
    retry: false,
  });

  const customNotice = data?.privacyNoticeMarkdown;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {slug && (
          <a
            href={`/book/${slug}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-8 group"
          >
            <span className="transition-transform group-hover:-translate-x-0.5">←</span>
            Back to booking
          </a>
        )}
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">Effective Date: March 20, 2026</p>

        {isLoading && (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-5/6" />
          </div>
        )}

        {!isLoading && customNotice && (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>
              {customNotice}
            </ReactMarkdown>
          </div>
        )}

        {!isLoading && !customNotice && <DefaultPrivacyContent />}

        <footer className="mt-12 pt-6 border-t text-sm text-muted-foreground flex flex-wrap gap-4">
          <span>&copy; {new Date().getFullYear()} HCP CRM / hcpcrm.com</span>
          <Link href="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
        </footer>
      </div>
    </main>
  );
}
