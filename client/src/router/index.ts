import { createRouter, createWebHistory } from 'vue-router'
import NotFound from '@/views/NotFound.vue'

const isAuthenticated = false      // TODO fix this

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: NotFound },
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue')
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/views/ProfileView.vue')
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/auth/LoginView.vue')
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/auth/RegisterView.vue')    
    },
  ]
})

// * Authentication Guard
router.beforeEach(async (to) => {

  // no access to any page other than login and register when user is unauthenticated
  // access to login and register is always allowed
  if (
    to.name !== 'register' &&
    to.name !== 'login' &&
    !isAuthenticated
  ) {
    return { name: 'login' }  // redirect to login page
  }
})

export default router
