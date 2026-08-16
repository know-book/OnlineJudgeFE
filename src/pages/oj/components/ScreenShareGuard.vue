<template>
  <div class="proctor-root">
    <!--
      Opaque, not a translucent iView Modal mask: the questions behind this
      must not be readable. z-index clears NavBar's 1000, the highest in src/.
    -->
    <div v-if="gateVisible" class="proctor-gate">
      <div class="proctor-panel">

        <template v-if="loading">
          <Spin size="large"></Spin>
          <p class="proctor-loading">{{$t('m.Proctor_Loading')}}</p>
        </template>

        <template v-else-if="block">
          <Icon type="alert-circled" class="proctor-icon proctor-icon-blocked"></Icon>
          <h1 class="proctor-title">{{blockedTitle}}</h1>
          <p class="proctor-lead">{{blockedBody}}</p>
        </template>

        <template v-else>
          <h1 class="proctor-title">
            {{stopped ? $t('m.Proctor_Stopped_Title') : $t('m.Proctor_Title')}}
          </h1>

          <p v-if="stopped" class="proctor-lead proctor-lead-alert">
            {{$t('m.Proctor_Stopped_Body')}}
          </p>
          <p v-else class="proctor-lead">{{$t('m.Proctor_Intro')}}</p>

          <Alert v-if="errorMessage" type="error" show-icon class="proctor-alert">
            {{errorMessage}}
            <template slot="desc" v-if="showPermissionHint">
              {{$t('m.Proctor_macOS_Hint')}}
            </template>
          </Alert>

          <div class="proctor-notice">
            <p>{{$t('m.Proctor_Check_Notice')}}</p>
            <p>{{$t('m.Proctor_Enforcement')}}</p>
            <p class="proctor-rules">{{$t('m.Proctor_Rules_Notice')}}</p>
          </div>

          <Button type="primary" size="large" long
                  :loading="requesting"
                  @click="share">
            {{attempted ? $t('m.Proctor_Retry_Button') : $t('m.Proctor_Share_Button')}}
          </Button>
        </template>

      </div>
    </div>

    <!--
      Bottom left, not right: App.vue renders iView's <BackTop>, which parks
      itself at bottom: 30px; right: 30px.
    -->
    <div v-if="monitorVisible" class="proctor-monitor">
      <div class="proctor-monitor-bar" @click="collapsed = !collapsed">
        <span class="proctor-dot" :class="{'proctor-dot-paused': muted}"></span>
        <span class="proctor-monitor-title">
          {{muted ? $t('m.Proctor_Monitor_Paused') : $t('m.Proctor_Monitor_Title')}}
        </span>
        <Icon :type="collapsed ? 'chevron-up' : 'chevron-down'"
              :title="collapsed ? $t('m.Proctor_Monitor_Expand') : $t('m.Proctor_Monitor_Collapse')">
        </Icon>
      </div>
      <!-- v-show, not v-if: the <video> is adopted into this node once. -->
      <div v-show="!collapsed" ref="videoSlot" class="proctor-monitor-video"></div>
      <p v-show="!collapsed && multiDisplay" class="proctor-monitor-warn">
        {{$t('m.Proctor_Multi_Display')}}
      </p>
    </div>
  </div>
</template>

<script>
  import screenShare, { STATUS, REASON } from '@/utils/screenShare'

  // Verdicts about the browser itself: no share button, no way forward here.
  const TERMINAL_STATUSES = [STATUS.UNSUPPORTED, STATUS.UNVERIFIABLE, STATUS.INSECURE]

  export default {
    name: 'ScreenShareGuard',
    props: {
      // The contest is still being fetched. Shows an opaque shield rather than
      // the share prompt, so the question list never flashes into view while
      // ContestDetail waits on getContest().
      loading: {
        type: Boolean,
        default: false
      }
    },
    data () {
      return {
        // A property of the browser, not of the session, so it is read once and
        // never cleared by stop(). See the block computed for the case where
        // the browser only gives itself away after the picker closes.
        initialBlock: screenShare.browserBlock(),
        status: STATUS.IDLE,
        reason: null,
        surface: null,
        muted: false,
        multiDisplay: false,
        collapsed: false,
        // Not reactive state anyone renders; kept here so it dies with the
        // instance. null means "we are not holding the scroll lock".
        savedOverflow: null
      }
    },
    mounted () {
      this.unsubscribe = screenShare.subscribe(state => {
        this.status = state.status
        this.reason = state.reason
        this.surface = state.surface
        this.muted = state.muted
        this.multiDisplay = state.multiDisplay
      })
      // ContestDetail's root carries a transform for 800ms after entry (the
      // fadeInUp transition in App.vue), which would make it the containing
      // block for our position: fixed children and shove the overlay down by
      // the navbar height at exactly the wrong moment. Move out of the way.
      document.body.appendChild(this.$el)
      this.syncScroll()
      if (this.monitorVisible) {
        this.$nextTick(this.adoptVideo)
      }
    },
    beforeDestroy () {
      if (this.unsubscribe) {
        this.unsubscribe()
      }
      if (this.savedOverflow !== null) {
        document.body.style.overflow = this.savedOverflow
        this.savedOverflow = null
      }
      // Vue's own teardown reads the element's current parentNode, so removing
      // it here keeps v-if in the parent working after the move above.
      if (this.$el.parentNode) {
        this.$el.parentNode.removeChild(this.$el)
      }
    },
    methods: {
      share () {
        // Called straight from @click with nothing awaited in front of it:
        // getDisplayMedia needs transient activation.
        screenShare.request()
      },
      // Save and restore rather than blanking: iView's Modal locks body scroll
      // the same way, and the login modal can be open underneath us.
      syncScroll () {
        if (this.gateVisible) {
          if (this.savedOverflow === null) {
            this.savedOverflow = document.body.style.overflow
          }
          document.body.style.overflow = 'hidden'
        } else if (this.savedOverflow !== null) {
          document.body.style.overflow = this.savedOverflow
          this.savedOverflow = null
        }
      },
      adoptVideo () {
        let slot = this.$refs.videoSlot
        let video = screenShare.getVideoElement()
        if (!slot) {
          return
        }
        if (video.parentNode !== slot) {
          slot.appendChild(video)
        }
        // Taking a <video> out of the document pauses it, and autoplay does
        // not fire again on reinsertion — so the thumbnail would freeze every
        // time the guard is remounted (e.g. after the login modal closes).
        if (video.paused) {
          let played = video.play()
          if (played && played.catch) {
            played.catch(() => {})
          }
        }
      }
    },
    computed: {
      // A browser can also fail the check late: one that advertises the
      // displaySurface constraint but leaves it out of getSettings() gets as
      // far as the picker before we find out. Without folding that back into
      // the terminal verdict the candidate would sit on a share button that
      // silently refuses every attempt.
      block () {
        if (this.initialBlock) {
          return this.initialBlock
        }
        return TERMINAL_STATUSES.indexOf(this.status) !== -1 ? this.status : null
      },
      gateVisible () {
        return this.loading || !!this.block || this.status !== STATUS.ACTIVE
      },
      monitorVisible () {
        return !this.loading && !this.block && this.status === STATUS.ACTIVE
      },
      requesting () {
        return this.status === STATUS.REQUESTING
      },
      stopped () {
        return this.status === STATUS.STOPPED
      },
      // Anything other than the very first prompt gets "try again" wording.
      attempted () {
        return this.status === STATUS.REJECTED || this.status === STATUS.STOPPED
      },
      blockedTitle () {
        return this.block === STATUS.INSECURE
          ? this.$i18n.t('m.Proctor_Title')
          : this.$i18n.t('m.Proctor_Unsupported_Title')
      },
      blockedBody () {
        if (this.block === STATUS.INSECURE) {
          return this.$i18n.t('m.Proctor_Insecure_Body')
        }
        if (this.block === STATUS.UNVERIFIABLE) {
          return this.$i18n.t('m.Proctor_Unverifiable_Body')
        }
        return this.$i18n.t('m.Proctor_Unsupported_Body')
      },
      // Chrome on macOS fails silently until the OS grants the browser screen
      // recording, and it surfaces as the same NotAllowedError as a cancelled
      // picker. Cheaper to always mention it than to field the support ticket.
      showPermissionHint () {
        return this.status === STATUS.REJECTED && this.reason !== REASON.WRONG_SURFACE
      },
      errorMessage () {
        if (this.status !== STATUS.REJECTED) {
          return ''
        }
        if (this.reason === REASON.WRONG_SURFACE) {
          return this.$i18n.t('m.Proctor_Wrong_Surface')
        }
        if (this.reason === REASON.DENIED) {
          return this.$i18n.t('m.Proctor_Denied')
        }
        return this.$i18n.t('m.Proctor_Error')
      }
    },
    watch: {
      gateVisible () {
        this.syncScroll()
      },
      monitorVisible (val) {
        if (val) {
          this.$nextTick(this.adoptVideo)
        }
      }
    }
  }
</script>

<style scoped lang="less">
  .proctor-gate {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    // Opaque on purpose. NavBar is z-index 1000.
    background: #fff;
    z-index: 9000;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }

  .proctor-panel {
    width: 100%;
    max-width: 620px;
    text-align: center;
  }

  .proctor-icon {
    font-size: 48px;
    &-blocked {
      color: #ed3f14;
    }
  }

  .proctor-title {
    font-size: 24px;
    font-weight: 500;
    margin: 12px 0 16px;
  }

  .proctor-lead {
    font-size: 15px;
    line-height: 1.7;
    margin-bottom: 20px;
    &-alert {
      color: #ed3f14;
    }
  }

  .proctor-loading {
    margin-top: 16px;
    color: #80848f;
  }

  .proctor-alert {
    text-align: left;
    margin-bottom: 20px;
  }

  .proctor-notice {
    text-align: left;
    background: #f8f8f9;
    border: 1px solid #e9eaec;
    border-radius: 4px;
    padding: 16px 20px;
    margin-bottom: 24px;
    p {
      font-size: 13px;
      line-height: 1.8;
      color: #495060;
      margin-bottom: 8px;
      &:last-child {
        margin-bottom: 0;
      }
    }
    .proctor-rules {
      color: #ed3f14;
    }
  }

  .proctor-monitor {
    position: fixed;
    left: 16px;
    bottom: 16px;
    width: 240px;
    background: #fff;
    border: 1px solid #dddee1;
    border-radius: 4px;
    box-shadow: 0 1px 6px rgba(0, 0, 0, .2);
    overflow: hidden;
    z-index: 8000;

    &-bar {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }

    &-title {
      flex: 1 1 auto;
      margin-left: 6px;
    }

    &-video {
      line-height: 0;
      background: #000;
    }

    &-warn {
      font-size: 12px;
      line-height: 1.5;
      color: #ff9900;
      padding: 6px 10px;
    }
  }

  .proctor-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #19be6b;
    &-paused {
      background: #ff9900;
    }
  }
</style>
