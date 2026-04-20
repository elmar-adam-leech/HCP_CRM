import { Link } from "wouter";

export default function TermsOfService() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-8">Effective Date: March 20, 2026</p>

        <p className="mb-6">
          These Terms of Service ("Terms") govern your access to and use of the CRM platform operated by{" "}
          <strong>HCP CRM</strong> at <strong>hcpcrm.com</strong> (the "Service"). By accessing or
          using the Service, you agree to be bound by these Terms. If you do not agree, do not use the
          Service.
        </p>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">1. Description of Service</h2>
          <p>
            hcpcrm.com provides a software-as-a-service (SaaS) customer relationship management platform
            designed for HVAC and home-service contractors. Features include lead tracking, appointment
            scheduling, email integration via Gmail, estimate management, workflow automation, and
            reporting.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">2. Account Registration</h2>
          <p className="mb-3">
            To use the Service you must create an account. You agree to:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Provide accurate and complete registration information.</li>
            <li>Keep your password confidential and notify us immediately of any unauthorized access.</li>
            <li>
              Accept responsibility for all activity that occurs under your account, whether or not
              authorized by you.
            </li>
          </ul>
          <p className="mt-3">
            You must be at least 18 years old to create an account.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">3. Acceptable Use</h2>
          <p className="mb-3">You agree not to use the Service to:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Violate any applicable local, state, national, or international law or regulation.</li>
            <li>
              Send unsolicited bulk email ("spam") or otherwise violate anti-spam laws (e.g., CAN-SPAM,
              CASL).
            </li>
            <li>Harass, abuse, or harm any person.</li>
            <li>
              Upload, transmit, or store malicious code, viruses, or any content that infringes on
              intellectual property rights.
            </li>
            <li>
              Attempt to gain unauthorized access to the Service or its related systems.
            </li>
            <li>
              Reverse-engineer, decompile, or otherwise attempt to derive the source code of the Service.
            </li>
            <li>Resell, sublicense, or otherwise make the Service available to third parties without
              our prior written consent.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">4. Data Ownership</h2>
          <p>
            You retain full ownership of all data you upload or create in the Service ("Your Data"),
            including customer records, emails, and documents. You grant us a limited, non-exclusive,
            royalty-free license to store, process, and display Your Data solely for the purpose of
            providing the Service to you. We will not use Your Data for any other purpose without your
            consent.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">5. Third-Party Integrations</h2>
          <p>
            The Service may integrate with third-party services such as Google Gmail. Your use of those
            integrations is governed by the respective third-party's terms and privacy policies. We are not
            responsible for the availability, accuracy, or conduct of any third-party service.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">6. Payment and Subscription</h2>
          <p>
            Certain features of the Service may require a paid subscription. All fees are stated in USD and
            are non-refundable except as required by law or as explicitly stated in a separate agreement.
            We reserve the right to modify pricing with at least 30 days' advance notice. Continued use of
            the Service after a price change constitutes acceptance of the new pricing.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">7. Intellectual Property</h2>
          <p>
            The Service, including its design, software, and content (excluding Your Data), is owned by
            HCP CRM and its licensors and is protected by copyright, trademark, and other intellectual
            property laws. Nothing in these Terms grants you any right to use our trademarks, logos, or
            brand features without prior written consent.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">8. Disclaimer of Warranties</h2>
          <p>
            THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER
            EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS
            FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
            UNINTERRUPTED, ERROR-FREE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">9. Limitation of Liability</h2>
          <p>
            TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL HCP CRM OR ITS
            OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED
            DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES,
            RESULTING FROM (A) YOUR ACCESS TO OR USE OF (OR INABILITY TO ACCESS OR USE) THE SERVICE; (B)
            ANY CONDUCT OR CONTENT OF ANY THIRD PARTY; OR (C) UNAUTHORIZED ACCESS, USE, OR ALTERATION OF
            YOUR DATA. IN NO EVENT SHALL OUR TOTAL LIABILITY EXCEED THE AMOUNT YOU PAID US IN THE 12
            MONTHS PRECEDING THE CLAIM.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">10. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless HCP CRM and its affiliates, officers, directors,
            employees, and agents from any claims, damages, losses, liabilities, and expenses (including
            reasonable attorneys' fees) arising from your use of the Service, Your Data, or your violation
            of these Terms.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">11. Termination</h2>
          <p className="mb-3">
            You may terminate your account at any time by contacting us. We may suspend or terminate your
            access to the Service at any time, with or without notice, if:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>You violate these Terms.</li>
            <li>We are required to do so by law.</li>
            <li>We discontinue the Service.</li>
          </ul>
          <p className="mt-3">
            Upon termination, your right to use the Service ceases immediately. Sections that by their
            nature should survive termination (including Sections 7, 8, 9, and 10) will survive.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">12. Governing Law</h2>
          <p>
            These Terms are governed by and construed in accordance with the laws of the State of
            California, without regard to its conflict of law provisions. Any disputes arising under these
            Terms shall be resolved exclusively in the state or federal courts located in California, and
            you consent to personal jurisdiction therein.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">13. Changes to These Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. We will notify you of material changes
            by posting the updated Terms on this page with a revised effective date. Your continued use of
            the Service after changes take effect constitutes acceptance of the revised Terms.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">14. Contact Us</h2>
          <p>
            Questions about these Terms? Contact us at:{" "}
            <a href="mailto:legal@hcpcrm.com" className="underline text-primary">
              legal@hcpcrm.com
            </a>
          </p>
        </section>

        <footer className="mt-12 pt-6 border-t text-sm text-muted-foreground flex flex-wrap gap-4">
          <span>&copy; {new Date().getFullYear()} HCP CRM / hcpcrm.com</span>
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
        </footer>
      </div>
    </main>
  );
}
