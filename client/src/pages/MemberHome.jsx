import Header from '../components/Header.jsx';
import { useAuth } from '../auth.jsx';

export default function MemberHome() {
  const { me } = useAuth();
  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-2xl mx-auto p-6">
        <h2 className="text-xl font-semibold">
          Welcome, {me.user.first_name}
        </h2>
        <p className="mt-2 text-slate-600">
          You're signed in to {me.tenant.name} as a member. Booking + credits
          ship in upcoming phases.
        </p>
      </main>
    </div>
  );
}
