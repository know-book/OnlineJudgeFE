<template>
  <div class="flex-container">
    <!--
      Every contest child route nests under this component, so mounting the
      guard here covers the whole contest without restarting the capture when
      the candidate moves between problems. It moves itself to document.body.
    -->
    <ScreenShareGuard v-if="proctorVisible" :loading="!contestLoaded"/>
    <div id="contest-main">
      <!--children-->
      <transition name="fadeInUp">
        <router-view></router-view>
      </transition>
      <!--children end-->
      <div class="flex-container" v-if="route_name === 'contest-details'">
        <template>
          <div id="contest-desc">
            <Panel :padding="20" shadow>
              <div slot="title">
                {{contest.title}}
              </div>
              <div slot="extra">
                <Tag type="dot" :color="countdownColor">
                  <span id="countdown">{{countdown}}</span>
                </Tag>
              </div>
              <div v-html="contest.description" class="markdown-body"></div>
              <div v-if="passwordFormVisible" class="contest-password">
                <Input v-model="contestPassword" type="password"
                       placeholder="contest password" class="contest-password-input"
                       @on-enter="checkPassword"/>
                <Button type="info" @click="checkPassword">Enter</Button>
              </div>
            </Panel>
            <Table :columns="columns" :data="contest_table" disabled-hover style="margin-bottom: 40px;"></Table>
          </div>
        </template>
      </div>

    </div>
    <div v-show="showMenu" id="contest-menu">
      <VerticalMenu @on-click="handleRoute">
        <VerticalMenu-item :route="{name: 'contest-details', params: {contestID: contestID}}">
          <Icon type="home"></Icon>
          {{$t('m.Overview')}}
        </VerticalMenu-item>

        <VerticalMenu-item :disabled="contestMenuDisabled"
                           :route="{name: 'contest-announcement-list', params: {contestID: contestID}}">
          <Icon type="chatbubble-working"></Icon>
          {{$t('m.Announcements')}}
        </VerticalMenu-item>

        <VerticalMenu-item :disabled="contestMenuDisabled"
                           :route="{name: 'contest-problem-list', params: {contestID: contestID}}">
          <Icon type="ios-photos"></Icon>
          {{$t('m.Problems')}}
        </VerticalMenu-item>

        <VerticalMenu-item v-if="OIContestRealTimePermission"
                           :disabled="contestMenuDisabled"
                           :route="{name: 'contest-submission-list'}">
          <Icon type="navicon-round"></Icon>
          {{$t('m.Submissions')}}
        </VerticalMenu-item>

        <VerticalMenu-item v-if="OIContestRealTimePermission"
                           :disabled="contestMenuDisabled"
                           :route="{name: 'contest-rank', params: {contestID: contestID}}">
          <Icon type="stats-bars"></Icon>
          {{$t('m.Rankings')}}
        </VerticalMenu-item>

        <VerticalMenu-item v-if="showAdminHelper"
                           :route="{name: 'acm-helper', params: {contestID: contestID}}">
          <Icon type="ios-paw"></Icon>
          {{$t('m.Admin_Helper')}}
        </VerticalMenu-item>
      </VerticalMenu>
    </div>
  </div>
</template>

<script>
  import moment from 'moment'
  import api from '@oj/api'
  import { mapState, mapGetters, mapActions } from 'vuex'
  import { types } from '@/store'
  import { CONTEST_STATUS_REVERSE, CONTEST_STATUS, STORAGE_KEY } from '@/utils/constants'
  import time from '@/utils/time'
  import storage from '@/utils/storage'
  import screenShare from '@/utils/screenShare'
  import ScreenShareGuard from '@oj/components/ScreenShareGuard.vue'

  export default {
    name: 'ContestDetail',
    components: {
      ScreenShareGuard
    },
    data () {
      return {
        CONTEST_STATUS: CONTEST_STATUS,
        route_name: '',
        btnLoading: false,
        contestID: '',
        contestPassword: '',
        columns: [
          {
            title: this.$i18n.t('m.StartAt'),
            render: (h, params) => {
              return h('span', time.utcToLocal(params.row.start_time))
            }
          },
          {
            title: this.$i18n.t('m.EndAt'),
            render: (h, params) => {
              return h('span', time.utcToLocal(params.row.end_time))
            }
          },
          {
            title: this.$i18n.t('m.ContestType'),
            render: (h, params) => {
              return h('span', this.$i18n.t('m.' + params.row.contest_type ? params.row.contest_type.replace(' ', '_') : ''))
            }
          },
          {
            title: this.$i18n.t('m.Rule'),
            render: (h, params) => {
              return h('span', this.$i18n.t('m.' + params.row.rule_type))
            }
          },
          {
            title: this.$i18n.t('m.Creator'),
            render: (h, data) => {
              return h('span', data.row.created_by.username)
            }
          }
        ]
      }
    },
    mounted () {
      this.contestID = this.$route.params.contestID
      this.route_name = this.$route.name
      this.$store.dispatch('getContest').then(res => {
        this.changeDomTitle({title: res.data.data.title})
        let data = res.data.data
        let endTime = moment(data.end_time)
        if (endTime.isAfter(moment(data.now))) {
          this.timer = setInterval(() => {
            this.$store.commit(types.NOW_ADD_1S)
          }, 1000)
        }
      })
    },
    methods: {
      ...mapActions(['changeDomTitle']),
      handleRoute (route) {
        this.$router.push(route)
      },
      checkPassword () {
        if (this.contestPassword === '') {
          this.$error('Password can\'t be empty')
          return
        }
        this.btnLoading = true
        api.checkContestPassword(this.contestID, this.contestPassword).then((res) => {
          this.$success('Succeeded')
          this.$store.commit(types.CONTEST_ACCESS, {access: true})
          this.btnLoading = false
        }, (res) => {
          this.btnLoading = false
        })
      }
    },
    computed: {
      ...mapState({
        showMenu: state => state.contest.itemVisible.menu,
        contest: state => state.contest.contest,
        contest_table: state => [state.contest.contest],
        now: state => state.contest.now
      }),
      ...mapGetters(
        ['contestLoaded', 'contestMenuDisabled', 'contestRuleType', 'contestStatus', 'countdown', 'isContestAdmin',
          'OIContestRealTimePermission', 'passwordFormVisible', 'isAuthenticated', 'modalStatus']
      ),
      // Whether this contest is invigilated at all. Drives the teardown, so it
      // deliberately ignores anything transient — see proctorVisible.
      proctorRequired () {
        if (!screenShare.isProctoredHost()) {
          return false
        }
        // getContest() is async and the child route mounts alongside it, and
        // getProfile() decides both isContestAdmin and isAuthenticated. Shield
        // the page until both have landed, or the questions are readable for
        // the couple of hundred ms in between. STORAGE_KEY.AUTHED is written
        // synchronously on the last profile load, so it tells us a profile is
        // still on its way rather than absent.
        let profilePending = !this.isAuthenticated && !!storage.get(STORAGE_KEY.AUTHED)
        if (!this.contestLoaded || profilePending) {
          return true
        }
        if (this.isContestAdmin) {
          return false
        }
        // Signed out they cannot read the questions anyway, and covering the
        // page would leave them nowhere to sign in.
        if (!this.isAuthenticated) {
          return false
        }
        // The private-contest password box lives behind the overlay at the top
        // of this file, so let them answer it first. contestMenuDisabled
        // already keeps the questions out of reach until they do.
        if (this.passwordFormVisible) {
          return false
        }
        // Only while it is actually being sat. Before the start the menu is
        // disabled anyway; after the end submission is closed and demanding a
        // screen capture to read solutions would be pure intrusion.
        return this.contestStatus === CONTEST_STATUS.UNDERWAY
      },
      // Whether to show it this instant. Kept separate from proctorRequired so
      // that stepping aside for the login modal — which api.js pops on any
      // "Please login" response, and which our z-index would otherwise bury —
      // does not also stop a perfectly good capture and make the candidate
      // share their screen again.
      proctorVisible () {
        return this.proctorRequired && !this.modalStatus.visible
      },
      countdownColor () {
        if (this.contestStatus) {
          return CONTEST_STATUS_REVERSE[this.contestStatus].color
        }
      },
      showAdminHelper () {
        return this.isContestAdmin && this.contestRuleType === 'ACM'
      }
    },
    watch: {
      '$route' (newVal) {
        this.route_name = newVal.name
        this.contestID = newVal.params.contestID
        this.changeDomTitle({title: this.contest.title})
      },
      proctorRequired (val) {
        // The contest ended mid-session, the admin profile arrived late, or we
        // moved to a contest this user runs. Give the screen back.
        if (!val) {
          screenShare.stop()
        }
      }
    },
    beforeDestroy () {
      clearInterval(this.timer)
      // Only reached when leaving the contest area entirely — the child routes
      // share this component. Leaves no "sharing your screen" bar behind.
      screenShare.stop()
      this.$store.commit(types.CLEAR_CONTEST)
    }
  }
</script>

<style scoped lang="less">
  pre {
    display: inline-block;
  }

  #countdown {
    font-size: 16px;
  }

  .flex-container {
    #contest-main {
      flex: 1 1;
      width: 0;
      #contest-desc {
        flex: auto;
      }
    }
    #contest-menu {
      flex: none;
      width: 210px;
      margin-left: 20px;
    }
    .contest-password {
      margin-top: 20px;
      margin-bottom: -10px;
      &-input {
        width: 200px;
        margin-right: 10px;
      }
    }
  }
</style>
