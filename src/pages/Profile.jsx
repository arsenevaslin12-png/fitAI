import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { useState, useEffect } from 'react'
import { Loader2, LogOut } from 'lucide-react'

export default function Profile() {
  const { user, signOut } = useAuth()
  const qc = useQueryClient()
  const [pseudo, setPseudo] = useState('')

  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('*').eq('user_id', user.id).maybeSingle()
      return data
    },
    enabled: !!user
  })

  useEffect(() => { if (profile?.pseudo) setPseudo(profile.pseudo) }, [profile])

  const { data: stats } = useQuery({
    queryKey: ['stats', user?.id],
    queryFn: async () => {
      const [sess, scans, posts] = await Promise.all([
        supabase.from('workout_sessions').select('id', { count: 'exact' }).eq('user_id', user.id),
        supabase.from('body_scans').select('id', { count: 'exact' }).eq('user_id', user.id),
        supabase.from('community_posts').select('id', { count: 'exact' }).eq('user_id', user.id),
      ])
      return { sessions: sess.count ?? 0, scans: scans.count ?? 0, posts: posts.count ?? 0 }
    },
    enabled: !!user
  })

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('profiles').upsert({ user_id: user.id, pseudo }, { onConflict: 'user_id' })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Profil enregistré ✓'); qc.invalidateQueries({ queryKey: ['profile'] }) },
    onError: e => toast.error(e.message)
  })

  const initial = (pseudo || user?.email || '?')[0].toUpperCase()

  return (
    <div className="p-6 max-w-xl mx-auto space-y-6">
      <h1 className="text-2xl font-black text-gray-900">👤 Mon Profil</h1>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white text-2xl font-black shadow-lg flex-shrink-0">
          {initial}
        </div>
        <div>
          <p className="font-bold text-gray-900 text-lg">{pseudo || '—'}</p>
          <p className="text-sm text-gray-400">{user?.email}</p>
        </div>
      </div>

      {stats && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <div className="grid grid-cols-3 gap-4 text-center">
            {[['Séances', stats.sessions], ['Scans', stats.scans], ['Posts', stats.posts]].map(([l, v]) => (
              <div key={l}>
                <div className="text-2xl font-black text-blue-600">{v}</div>
                <div className="text-xs text-gray-400 font-medium uppercase tracking-wide">{l}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
        <h2 className="font-bold text-gray-900">Modifier mon profil</h2>
        <input value={pseudo} onChange={e => setPseudo(e.target.value)} placeholder="Votre pseudo…"
          className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
        />
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Enregistrer
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-red-100 p-5 shadow-sm">
        <h2 className="font-bold text-red-600 mb-3">Zone danger</h2>
        <button onClick={signOut} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-50 text-red-600 font-bold text-sm hover:bg-red-100 transition-colors border border-red-200">
          <LogOut className="w-4 h-4" />Déconnexion
        </button>
      </div>
    </div>
  )
}
