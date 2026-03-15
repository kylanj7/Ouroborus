import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import ToastContainer from './ToastContainer'
import IndexingBanner from './IndexingBanner'

export default function Layout() {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <Outlet />
      </main>
      <ToastContainer />
      <IndexingBanner />
    </div>
  )
}
