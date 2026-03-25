\- \*\*2026-02-23 phase 1: Infrastructure \& Database Design\*\*

\- \*\*2026-03-02 phase 2:API Gateway \& JWT Authentication\*\*

\- \*\*2026-03-09 phase 3: Core Node.js API (Courses \& Transfers)\*\*

\- \*\*2026-03-16 phase 4: React Frontend - Student Dashboard (UI Layout)\*\*

\- \*\*2026-03-23 phase 4: React Frontend - Student Dashboard (Integration \& Uploads)\*\*

\- \*\*2026-03-30 phase 5: Python Worker Microservice (PDF \& OCR)\*\*

\- \*\*2026-04-06 phase 6: React Frontend - Evaluator Split-Screen UI\*\*

\- \*\*2026-04-13 phase 7: Admin Panel \& Rule Engine Configuration\*\*

\- \*\*2026-04-20 phase 8: Full System Integration \& End-to-End Testing\*\*

\- \*\*2026-04-27 phase 9: Bug Fixing \& Performance Optimization\*\*

\- \*\*2026-05-04 phase 10: Final Deployment \& Documentation (Target: May 9)\*\*



---



\## 🛠️ Phase Details



\### Week 1: Infrastructure \& Database Design (Feb 23 - Mar 1)

\* Set up local development environment (Docker/docker-compose).

\* Design PostgreSQL relational schema (Users, Universities, Courses, Transfer\_Rules, Requests).

\* Configure local MinIO server for PDF transcript object storage.



\### Week 2: API Gateway \& Authentication (Mar 2 - Mar 8)

\* Scaffold Node.js/Express API Gateway.

\* Implement JWT-based login and registration.

\* Set up Role-Based Access Control (RBAC) for `Student`, `Evaluator`, and `Admin`.



\### Week 3: Core Node.js API (Mar 9 - Mar 15)

\* Build CRUD endpoints for managing Course Equivalencies.

\* Create endpoints for creating, updating, and tracking Transfer Requests.

\* Integrate database queries to fetch dynamic dashboard statistics.



\### Week 4 \& 5: React Frontend - Student Dashboard (Mar 16 - Mar 29)

\* Scaffold React app and set up routing/state management (Context/Redux).

\* Build the UI based on the "Student Dashboard" wireframe.

\* Implement the Drag-and-Drop transcript upload component (using Presigned URLs to MinIO).

\* Create the dynamic Course Search and "Shopping Cart" interface.



\### Week 6: Python Worker Microservice (Mar 30 - Apr 5)

\* Set up an isolated Python service for heavy computation.

\* Implement OCR (Optical Character Recognition) to scan uploaded transcripts.

\* Implement PDF Generation to create official "Transfer Decision" reports.



\### Week 7 \& 8: Evaluator UI \& Admin Tools (Apr 6 - Apr 19)

\* Build the specific Evaluator portal.

\* Implement the Split-Screen view (PDF viewer on the left, Decision Form on the right).

\* Build the Admin Rule Engine editor to configure transfer logic.



\### Week 9 \& 10: Testing \& Optimization (Apr 20 - May 3)

\* Connect all React components to the live microservices via the API Gateway.

\* Test the end-to-end flow: Student Upload -> Auto-Processing -> Evaluator Decision.

\* Fix UI bugs and optimize database query speeds.



\### Week 11: Deployment (May 4 - May 9)

\* Containerize frontend and backend services for production.

\* Complete system documentation and final GitHub repository cleanup.

