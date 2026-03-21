import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import ToastContainer from './ToastContainer'
import IndexingBanner from './IndexingBanner'
import { useSidebarStore } from '../../store/sidebarStore'

export default function Layout() {
  const collapsed = useSidebarStore((s) => s.collapsed)

  return (
    <div className="app-layout">
      <Sidebar />
      <main className={`main-content${collapsed ? ' sidebar-collapsed' : ''}`}>
        <Outlet />
      </main>
      <ToastContainer />
      <IndexingBanner />
    </div>
  )
}
