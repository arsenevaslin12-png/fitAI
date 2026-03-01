import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Upload, Loader2, ScanLine } from 'lucide-react'

export default function BodyScan() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const fileRef = useRef()
  const [preview, setPreview] = useState(null)
  const [file, setFile] = useState(null)

  const { data: scans = [] } = useQuery({
    queryKey: ['scans', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('body_scans').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10)
      return data ?? []
    },
    enabled: !!user
  })

  const handleFile = (f) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast.error('Image requise (JPG, PNG, WEBP)')
    if (f.size > 6 * 1024 * 1024) return toast.error('Max 6MB')
    setFile(f)
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target.result)
    reader.readAsDataURL(f)
  }

  const scan = useMutation({
    mutationFn: async () => {
      if (!file) return
      const { data: { session } } = await supabase.auth.getSession()
      const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase()
      const path = `${user.id}/bodyscans/${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('user_uploads').upload(path, file, { contentType: file.type })
      if (upErr) throw new Error('Upload: ' + upErr.message)
      const { error: dbErr } = await supabase.from('body_scans').insert({ user_id: user.id, image_path: path })
      if (dbErr) throw new Error('DB: ' + dbErr.message)
      const res = await fetch('/api/bodyscan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: user.id, image_path: path })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
    },
    onSuccess: () => {
      toast.success('Analyse terminée ✓')
      setFile(null); setPreview(null)
      qc.invalidateQueries({ queryKey: ['scans'] })
    },
    onError: e => toast.error('Erreur: ' + e.message)
  })

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-black text-gray-900">📸 Scan IA</h1>
        <p className="text-sm text-gray-500 mt-1">Analysez votre physique avec l'intelligence artificielle</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4">Analyser une photo</h2>
        {!preview ? (
          <div
            className="border-2 border-dashed border-gray-200 rounded-2xl p-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-all"
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
          >
            <Upload className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500 text-sm font-medium">Cliquez ou déposez une photo</p>
            <p className="text-gray-400 text-xs mt-1">JPG, PNG, WEBP — max 6MB</p>
          </div>
        ) : (
          <div className="space-y-4">
            <img src={preview} alt="preview" className="w-full max-h-64 object-cover rounded-xl" />
            <div className="flex gap-3">
              <button onClick={() => scan.mutate()} disabled={scan.isPending}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {scan.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />}
                {scan.isPending ? 'Analyse en cours…' : 'Analyser avec l\'IA'}
              </button>
              <button onClick={() => { setPreview(null); setFile(null) }}
                className="px-4 py-3 rounded-xl bg-gray-100 text-gray-600 font-bold text-sm hover:bg-gray-200 transition-colors"
              >Annuler</button>
            </div>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => handleFile(e.target.files[0])} />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4">Mes analyses</h2>
        {scans.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Aucune analyse</p>
        ) : (
          <div className="space-y-4">
            {scans.map(s => (
              <div key={s.id} className="bg-gray-50 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">{new Date(s.created_at).toLocaleDateString('fr-FR')}</span>
                  <span className={`text-xs font-bold px-3 py-1 rounded-full ${s.ai_feedback ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {s.ai_feedback ? 'Analysé' : 'En attente'}
                  </span>
                </div>
                {s.ai_feedback && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {[['Symétrie', s.symmetry_score], ['Posture', s.posture_score], ['BF%', s.bodyfat_proxy]].map(([l, v]) => (
                        <div key={l} className="bg-white rounded-lg p-3 text-center border border-gray-100">
                          <div className="text-lg font-black text-blue-600">{v ?? '—'}</div>
                          <div className="text-[10px] text-gray-400 uppercase font-bold">{l}</div>
                        </div>
                      ))}
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed">{s.ai_feedback}</p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
