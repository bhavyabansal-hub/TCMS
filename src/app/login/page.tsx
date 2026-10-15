'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/store'
import { AuthScreen } from '@/components/auth-screen'
import { nextFromLocation } from '@/lib/routes'

/** /login — standalone auth page. Already-signed-in visitors go to the app
 *  (back to `?next=` when the session guard bounced them here). AuthScreen
 *  navigates to the same sanitized destination after login/register, so there
 *  is exactly ONE target no matter which effect wins. */
export default function LoginPage() {
  const user = useAuthStore((s) => s.user)
  const router = useRouter()

  useEffect(() => {
    if (user) router.replace(nextFromLocation())
  }, [user, router])

  return <AuthScreen />
}
