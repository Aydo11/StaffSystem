// Staff privacy notice (UK GDPR Articles 13–14). Public, so it can be read before signing up.
// Keep it in step with what the Hub actually does: a new kind of personal data or a new service provider belongs here.
import { PageHead } from '../ui.tsx';
import { Frame } from './Login.tsx';

export const UPDATED = '31 October 2026';

function Notice() {
  return (
    <div className="prose">
      <h2>Who is responsible for your information</h2>
      <p>The company you work for is the controller of your records in the Hub: Valor Housing Ltd, Wellbeing Homes Ltd or Wellbeing Housing Ltd. If you work for more than one, each is responsible for the records of the work you do for it.</p>
      <p>The Hub is run by Valor Housing Ltd, a company registered in England and Wales (company number 16175322). Registered office: 63 Grove Lane, Handsworth, Birmingham B21 9ES. Registered with the Information Commissioner's Office, reference ZC242198.</p>
      <p>Data Protection Officer: Ayden Yafai, <a href="mailto:info@valorhousing.co.uk">info@valorhousing.co.uk</a>.</p>

      <h2>What we hold</h2>
      <ul>
        <li>Account and profile: your name, work email, contact details, photo, job roles and the companies you work for.</li>
        <li>Employment records: leave, timesheets, training, CPD, supervision and performance records, and pre-employment checks such as right to work, references and DBS.</li>
        <li>Work records: visits (times, notes and photos), tasks, repairs, complaints, property records, messages and news posts.</li>
        <li>Location: when you press Start and Finish on a visit, if your device allows it. Your location is not tracked at any other time. If you do not allow it, the visit still starts.</li>
        <li>Security records: sign-ins and an audit log of who viewed or changed sensitive records.</li>
      </ul>

      <h2>Why we use it, and our lawful basis</h2>
      <ul>
        <li>To manage your employment, pay and leave: performance of your contract (UK GDPR Article 6(1)(b)).</li>
        <li>To meet our legal duties, including right to work, health and safety, safeguarding and tax: legal obligation (Article 6(1)(c)).</li>
        <li>To run safe, reliable housing services, show that visits took place, plan work and keep the Hub secure: our legitimate interests (Article 6(1)(f)). We have balanced these against your rights and keep location to the start and end of visits only.</li>
        <li>Sickness absence and criminal record (DBS) information: to meet our obligations as an employer and for safeguarding (Article 9(2)(b) and Article 10, with Schedule 1 of the Data Protection Act 2018).</li>
      </ul>

      <h2>AI assistant</h2>
      <p>If your company switches on the AI assistant, the records needed to answer a question or draft a summary are sent to Anthropic, which provides the AI model. It only uses records the person asking can already see. AI drafts are reviewed by people: the AI does not make decisions about you that have legal or similarly significant effects, and a manager can change any task handed over while someone is on leave. AI drafts are deleted after the period your company sets.</p>

      <h2>Who we share it with</h2>
      <ul>
        <li>Render (hosting and database, in Frankfurt, Germany).</li>
        <li>Resend (sending emails; Hub emails contain a link, not personal details).</li>
        <li>Anthropic (the AI assistant, only when it is switched on).</li>
        <li>postcodes.io receives property postcodes to place properties on the map. Map images are loaded from OpenStreetMap, which sees your device's internet address.</li>
        <li>Regulators, auditors, the police or courts when the law requires it.</li>
      </ul>
      <p>Some of these providers may process information outside the UK. Where they do, we rely on UK adequacy regulations or the safeguards UK law requires, such as the International Data Transfer Agreement or Addendum. We do not sell your information or use it for advertising.</p>

      <h2>Cookies and your device</h2>
      <p>The Hub keeps your sign-in and display choices (such as compact view) in your browser's storage. These are needed for the Hub to work or are settings you choose. There are no tracking, analytics or advertising cookies.</p>

      <h2>How long we keep it</h2>
      <p>We keep your records while you work for us and for six years after you leave, unless the law requires longer. After that your personal details are removed: business records such as visits, timesheets and finance are kept under "Former staff member".</p>

      <h2>Your rights</h2>
      <p>You can ask to see your information, correct it, have it deleted, restrict or object to how it is used, or receive a copy to take elsewhere. You can download your own data at any time from <strong>My profile → Download my data</strong>. For anything else, email our Data Protection Officer at <a href="mailto:info@valorhousing.co.uk">info@valorhousing.co.uk</a> or ask your manager. We reply within one month.</p>
      <p>If you are unhappy with how we use your information, you can complain to the Information Commissioner's Office: <a href="https://ico.org.uk/make-a-complaint/" target="_blank" rel="noopener noreferrer">ico.org.uk/make-a-complaint</a> or 0303 123 1113. We would like the chance to put things right first.</p>

      <p className="small muted">Last updated {UPDATED}.</p>
    </div>
  );
}

// Signed in: inside the app. Signed out: on the sign-in frame.
export function PrivacyPage() {
  return <><PageHead title="Privacy notice" intro="How the Hub uses information about staff." /><section className="card"><Notice /></section></>;
}

export function PublicPrivacy() {
  return <Frame><h1>Privacy notice</h1><p>How the Hub uses information about staff.</p><Notice /><p><a href="/">Back to sign in</a></p></Frame>;
}
