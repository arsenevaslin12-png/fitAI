import { Outlet, Link, useLocation } from 'react-router-dom'
import { useTheme } from 'next-themes'
import { useAuth } from '@/context/AuthContext'
import {
  Home, MessageCircle, Utensils, Zap, Dumbbell, User,
  Moon, Sun
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const NAV = [
  { title: 'Dashboard',    href: '/dashboard',  icon: Home },
  { title: 'Coach IA',     href: '/coach-ia',   icon: MessageCircle },
  { title: 'Nutrition',    href: '/nutrition',  icon: Utensils },
  { title: 'Scan IA',      href: '/body-scan',  icon: Zap },
  { title: 'Entraînements',href: '/workouts',   icon: Dumbbell },
  { title: 'Profil',       href: '/profile',    icon: User },
]

export default function Layout() {
  const location = useLocation()
  const { theme, setTheme } = useTheme()
  const { user, signOut } = useAuth()
  const isDark = theme === 'dark'

  return (
    <div className={cn('min-h-screen flex flex-col transition-colors duration-300',
      isDark ? 'bg-gray-900' : 'bg-slate-50'
    )}>
      {/* Mobile Header */}
      <header className={cn('md:hidden sticky top-0 z-40 backdrop-blur-md border-b px-4 py-3 flex items-center justify-between shadow-sm',
        isDark ? 'bg-gray-900/80 border-gray-800' : 'bg-white/80 border-gray-200'
      )}>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-cyan-600 rounded-lg flex items-center justify-center shadow-lg">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">
            FitAI Pro
          </span>
        </div>
        <button onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className={cn('p-2 rounded-lg transition-colors', isDark ? 'bg-gray-800 text-yellow-400' : 'bg-gray-100 text-gray-700')}
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </header>

      {/* Desktop Sidebar */}
      <aside className={cn('hidden md:flex fixed left-0 top-0 h-screen w-64 flex-col border-r shadow-xl transition-colors duration-300',
        isDark ? 'bg-gray-900/95 border-gray-800' : 'bg-white/90 border-gray-100'
      )}>
        {/* Brand */}
        <div className={cn('p-6 border-b', isDark ? 'border-gray-800' : 'border-gray-100')}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-600 via-cyan-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-xl">
              <Zap className="w-7 h-7 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-xl bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                FitAI Pro
              </h2>
              <p className={cn('text-xs', isDark ? 'text-gray-400' : 'text-gray-500')}>Coach IA personnel</p>
            </div>
          </div>
          <button onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className={cn('w-full p-3 rounded-xl flex items-center justify-center gap-2 transition-all text-sm font-semibold',
              isDark ? 'bg-gray-800 hover:bg-gray-700 text-yellow-400' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            )}
          >
            {isDark ? <><Sun className="w-4 h-4" /> Mode clair</> : <><Moon className="w-4 h-4" /> Mode sombre</>}
          </button>
        </div>

        {/* User */}
        {user && (
          <div className={cn('mx-4 mt-4 p-3 rounded-xl flex items-center gap-3', isDark ? 'bg-gray-800' : 'bg-gray-50')}>
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
              {(user.email?.[0] ?? '?').toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn('text-xs font-semibold truncate', isDark ? 'text-gray-200' : 'text-gray-800')}>{user.email}</p>
              <p className={cn('text-[10px]', isDark ? 'text-gray-500' : 'text-gray-400')}>Membre</p>
            </div>
            <button onClick={signOut} className={cn('text-xs px-2 py-1 rounded-lg transition-colors', isDark ? 'bg-gray-700 text-gray-300 hover:text-red-400' : 'bg-white text-gray-500 hover:text-red-500 border border-gray-200')}>
              Déco
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto mt-2">
          {NAV.map(item => {
            const active = location.pathname === item.href
            return (
              <Link key={item.href} to={item.href}
                className={cn('flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all duration-200 group',
                  active
                    ? 'bg-gradient-to-r from-blue-600 via-cyan-600 to-purple-600 text-white shadow-lg shadow-blue-500/25'
                    : isDark
                      ? 'text-gray-400 hover:bg-gray-800 hover:text-white'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                )}
              >
                <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center transition-all',
                  active ? 'bg-white/20' : isDark ? 'bg-gray-800 group-hover:bg-gray-700' : 'bg-gray-100 group-hover:bg-blue-50'
                )}>
                  <item.icon className="w-4 h-4" />
                </div>
                <span>{item.title}</span>
                {active && <div className="ml-auto w-2 h-2 rounded-full bg-white" />}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 md:ml-64 pb-20 md:pb-0">
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      <nav className={cn('md:hidden fixed bottom-0 left-0 right-0 z-40 border-t backdrop-blur-xl shadow-2xl transition-colors duration-300',
        isDark ? 'bg-gray-900/95 border-gray-800' : 'bg-white/95 border-gray-100'
      )}>
        <div className="grid grid-cols-5 gap-1 p-2">
          {NAV.slice(0, 5).map(item => {
            const active = location.pathname === item.href
            return (
              <Link key={item.href} to={item.href}
                className={cn('flex flex-col items-center gap-1 p-2 rounded-2xl text-[10px] font-bold transition-all',
                  active
                    ? 'bg-gradient-to-br from-blue-600 to-purple-600 text-white shadow-lg scale-105'
                    : isDark ? 'text-gray-500' : 'text-gray-500'
                )}
              >
                <div className={cn('w-7 h-7 rounded-xl flex items-center justify-center', active ? 'bg-white/20' : '')}>
                  <item.icon className="w-4 h-4" />
                </div>
                {item.title.split(' ')[0]}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
