import { useApp } from './session.tsx';
import { Link, Loading } from './ui.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Projects } from './pages/Projects.tsx';
import { NewProject } from './pages/NewProject.tsx';
import { Project } from './pages/Project.tsx';
import { BuildPage } from './pages/BuildPage.tsx';
import { Integrations } from './pages/Integrations.tsx';
import { Keys } from './pages/Keys.tsx';

export function App() {
  const { session, ready, route, supabase } = useApp();
  if (!ready) return <Loading />;
  if (!session) return <SignIn />;

  const section = route.name === 'integrations' ? 'integrations' : route.name === 'keys' ? 'keys' : 'projects';
  return (
    <>
      <header className="topbar">
        <Link to={{ name: 'projects' }} className="brand">
          Git2App
        </Link>
        <nav aria-label="Main">
          <Link to={{ name: 'projects' }} className={section === 'projects' ? 'active' : ''}>
            Apps
          </Link>
          <Link to={{ name: 'integrations', github: null }} className={section === 'integrations' ? 'active' : ''}>
            GitHub
          </Link>
          <Link to={{ name: 'keys' }} className={section === 'keys' ? 'active' : ''}>
            Keys
          </Link>
        </nav>
        <button className="btn btn-link" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <main className="page">
        {route.name === 'projects' && <Projects />}
        {route.name === 'new-project' && <NewProject />}
        {route.name === 'project' && <Project key={route.id} id={route.id} tab={route.tab} />}
        {route.name === 'build' && <BuildPage key={route.id} id={route.id} />}
        {route.name === 'integrations' && <Integrations github={route.github} />}
        {route.name === 'keys' && <Keys />}
        {route.name === 'not-found' && (
          <section className="card empty">
            <h1>Page not found</h1>
            <Link to={{ name: 'projects' }} className="btn btn-primary">
              Back to your apps
            </Link>
          </section>
        )}
      </main>
    </>
  );
}
